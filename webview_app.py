"""
Clipxel - punto de entrada de la version con interfaz web (pywebview).
El backend (motores de reparacion, lectura de metadata) es el mismo que
usaba la version CustomTkinter; solo cambia la capa visual.
"""
import base64
import datetime
import io
import json
import logging
import mimetypes
import os
import platform
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import webview
from PIL import Image, ImageFilter

import metadata_camara
import motores_reparacion as motores
from webview.dom import DOMEventHandler

try:
    import cv2
except ImportError:
    cv2 = None


def _carpeta_base():
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _ruta_local(nombre):
    candidato = os.path.join(_carpeta_base(), nombre)
    return candidato if os.path.isfile(candidato) else nombre


FFMPEG_BIN = _ruta_local("ffmpeg.exe") if os.name == "nt" else _ruta_local("ffmpeg")
FFPROBE_BIN = _ruta_local("ffprobe.exe") if os.name == "nt" else _ruta_local("ffprobe")
CARPETA_WEB = os.path.join(_carpeta_base(), "web")

GREEN_THRESHOLD = 40

PRESETS_VELOCIDAD = {
    "Rapido":      {"preset": "ultrafast", "crf": 18},
    "Equilibrado": {"preset": "veryfast",  "crf": 16},
    "Calidad":     {"preset": "slow",      "crf": 12},
}
RESOLUCIONES = {
    "Original": None,
    "1080p (1920x1080)": (1920, 1080),
    "720p (1280x720)": (1280, 720),
}

LIMITE_GRATIS_DIARIO = 5

SUPABASE_URL = "https://ujuibmpvicuibidkbdrq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_x3mWkJJdqcimXIVkgbHEUA_-TWxzxtf"

VERSION_APP = "2.4.2"
URL_ULTIMA_VERSION = "https://api.github.com/repos/clipxel/clipxel.github.io/releases/latest"
URL_PAGINA_DESCARGA = "https://clipxel.github.io"


def _version_a_tupla(texto):
    limpio = (texto or "").strip().lstrip("vV")
    partes = []
    for trozo in limpio.split("."):
        digitos = "".join(c for c in trozo if c.isdigit())
        partes.append(int(digitos) if digitos else 0)
    return tuple(partes) or (0,)


def _carpeta_datos_app():
    if os.name == "nt":
        base = os.environ["LOCALAPPDATA"]
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share"))
    carpeta = os.path.join(base, "Clipxel")
    os.makedirs(carpeta, exist_ok=True)
    return carpeta


def _ruta_datos_usuario(nombre_archivo):
    return os.path.join(_carpeta_datos_app(), nombre_archivo)


def _leer_carpeta_salida_personalizada():
    """Carpeta base (elegida por el usuario) donde crear la subcarpeta
    "Clipxel" de exportacion, en vez de la ubicacion por defecto (junto
    al medio original). None si no se configuro ninguna, o si la que se
    habia elegido ya no existe (ej. se desconecto un disco externo)."""
    try:
        with open(_ruta_datos_usuario("config.json"), "r", encoding="utf-8") as f:
            carpeta = json.load(f).get("carpeta_salida")
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return carpeta if carpeta and os.path.isdir(carpeta) else None


def _guardar_carpeta_salida_personalizada(carpeta):
    with open(_ruta_datos_usuario("config.json"), "w", encoding="utf-8") as f:
        json.dump({"carpeta_salida": carpeta}, f)


def _pil_a_b64(img, formato="PNG"):
    buf = io.BytesIO()
    img.save(buf, format=formato)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _b64_a_pil(data_url):
    _, _, datos = data_url.partition(",")
    return Image.open(io.BytesIO(base64.b64decode(datos)))


def _adaptar_mascara_a_clip(mascara_rgba, ancho_clip, alto_clip):
    """Adapta la mascara "de referencia" (dibujada sobre el frame de
    muestra) a la orientacion y resolucion reales de cada clip del lote.
    Misma camara puede haber filmado algunas tomas horizontales y otras
    verticales (o en otra resolucion) -- si no se corrige esto, la mascara
    queda girada o corrida de lugar en los clips que no coinciden con el
    frame sobre el que se pinto originalmente.
    Devuelve (mascara_adaptada, descripcion_rotacion_o_None)."""
    if not ancho_clip or not alto_clip:
        return mascara_rgba, None
    ancho_ref, alto_ref = mascara_rgba.size
    vertical_ref = alto_ref > ancho_ref
    vertical_clip = alto_clip > ancho_clip
    descripcion = None
    if vertical_ref != vertical_clip:
        if vertical_clip:
            # referencia horizontal, clip vertical: la camara se giro hacia
            # la izquierda para filmar en vertical -> se rota la mascara
            # 90 grados en sentido antihorario para que seguir el mismo giro.
            mascara_rgba = mascara_rgba.transpose(Image.ROTATE_90)
            descripcion = "90 grados a la izquierda"
        else:
            # referencia vertical, clip horizontal: giro opuesto.
            mascara_rgba = mascara_rgba.transpose(Image.ROTATE_270)
            descripcion = "90 grados a la derecha"
    if mascara_rgba.size != (ancho_clip, alto_clip):
        mascara_rgba = mascara_rgba.resize((ancho_clip, alto_clip))
    return mascara_rgba, descripcion


def reparar_crop_preview(motor_id, crop_rgb, mascara_crop_u8, sigma_blur=15):
    if motor_id == "blur":
        base = Image.fromarray(crop_rgb)
        blur_img = base.filter(ImageFilter.GaussianBlur(radius=sigma_blur))
        mask_norm = (mascara_crop_u8.astype(np.float32) / 255.0)[..., None]
        resultado = np.asarray(base).astype(np.float32) * (1 - mask_norm) + np.asarray(blur_img).astype(np.float32) * mask_norm
        return resultado.astype(np.uint8)
    if motor_id == "opencv" and cv2 is not None:
        bgr = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2BGR)
        reparado = cv2.inpaint(bgr, mascara_crop_u8, 5, cv2.INPAINT_TELEA)
        return cv2.cvtColor(reparado, cv2.COLOR_BGR2RGB)
    return crop_rgb


class Api:
    def __init__(self):
        self._ventana = None
        self._frame_actual = None  # PIL RGB del frame de muestra del clip activo
        self.progreso = {"completados": 0, "total": 0, "por_clip": [], "logs": [], "terminado": True}
        self._progreso_lock = threading.Lock()
        self._evento_cancelar = threading.Event()
        self._actualizacion_lock = threading.Lock()
        self._actualizacion = {"hay_actualizacion": False}
        self._preview_lock = threading.Lock()
        self._preview_render_b64 = None
        self._preview_render_ultima = 0.0
        self._motor_gpu_cache = "sin_probar"
        self._login_pendiente = None  # tokens de un login bloqueado por otro equipo, a la espera de que el usuario cierre esa sesion

    def _detectar_motor_gpu(self):
        """Prueba una sola vez por sesion que encoder de video acelerado por
        GPU funciona de verdad en esta PC (NVENC/QuickSync/AMF) y devuelve
        ese nombre, o None si no hay ninguno utilizable (cae a CPU/libx264)."""
        if self._motor_gpu_cache == "sin_probar":
            self._motor_gpu_cache = motores.detectar_motor_gpu(FFMPEG_BIN)
        return self._motor_gpu_cache

    def set_ventana(self, ventana):
        self._ventana = ventana

    # ---------- cuenta (login con Google) / limite gratis ----------
    def _cargar_sesion(self):
        try:
            with open(_ruta_datos_usuario("sesion.json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _guardar_sesion(self, datos):
        with open(_ruta_datos_usuario("sesion.json"), "w", encoding="utf-8") as f:
            json.dump(datos, f)

    def _borrar_sesion(self):
        try:
            os.remove(_ruta_datos_usuario("sesion.json"))
        except FileNotFoundError:
            pass

    def _id_dispositivo(self):
        """Identificador estable de esta instalacion (no es un fingerprint de
        hardware real, alcanza para que una cuenta Pro no se comparta entre
        varias PCs sin querer). Se genera una sola vez y se guarda aparte de
        la sesion, para que sobreviva a cerrar/iniciar sesion de nuevo."""
        ruta = _ruta_datos_usuario("dispositivo.json")
        try:
            with open(ruta, "r", encoding="utf-8") as f:
                datos = json.load(f)
            if datos.get("device_id"):
                return datos["device_id"]
        except Exception:
            pass
        import uuid
        nuevo_id = str(uuid.uuid4())
        with open(ruta, "w", encoding="utf-8") as f:
            json.dump({"device_id": nuevo_id}, f)
        return nuevo_id

    def _es_pro(self):
        # CLIPXEL Pro es gratis para todos: no hay limite diario ni
        # chequeo de plan, cualquier cuenta logueada cuenta como Pro.
        return True

    def estado_sesion(self):
        sesion = self._cargar_sesion()
        return {"logueado": bool(sesion.get("access_token")), "email": sesion.get("email")}

    def cerrar_sesion(self):
        """Cierra la sesion local. Ademas libera este dispositivo en el
        servidor: si no lo hacemos, la cuenta Pro queda "activa" en este
        equipo para siempre y bloquea el login en cualquier otro hasta que
        alguien entre a "Mis dispositivos" y lo cierre a mano."""
        try:
            self._llamar_rpc("cerrar_sesion_dispositivo", {"p_device_id": self._id_dispositivo()})
        except Exception:
            pass
        self._borrar_sesion()
        return {"ok": True}

    def iniciar_login_google(self):
        """Abre el navegador del sistema para el login de Google (via
        Supabase Auth, flujo PKCE) y espera a que el usuario lo complete.
        Al volver, liga automaticamente cualquier compra pendiente hecha con
        ese mismo email y activa Pro en este equipo si corresponde."""
        import base64
        import hashlib
        import http.server
        import secrets
        import urllib.parse
        import urllib.request
        import webbrowser

        code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode("ascii")).digest()
        ).decode("ascii").rstrip("=")

        resultado_callback = {}
        evento_listo = threading.Event()

        class ManejadorCallback(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                query = urllib.parse.urlparse(self.path).query
                params = urllib.parse.parse_qs(query)
                resultado_callback["code"] = (params.get("code") or [None])[0]
                resultado_callback["error"] = (params.get("error_description") or params.get("error") or [None])[0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    "<html><body style='font-family:sans-serif;text-align:center;padding-top:80px'>"
                    "<h2>Listo, volvé a Clipxel.</h2><p>Ya podés cerrar esta pestaña.</p>"
                    "</body></html>".encode("utf-8")
                )
                evento_listo.set()

            def log_message(self, *args):
                pass

        servidor = http.server.HTTPServer(("127.0.0.1", 0), ManejadorCallback)
        puerto = servidor.server_address[1]
        threading.Thread(target=servidor.handle_request, daemon=True).start()

        redirect_to = f"http://127.0.0.1:{puerto}/callback"
        url_login = (
            f"{SUPABASE_URL}/auth/v1/authorize?"
            + urllib.parse.urlencode({
                "provider": "google",
                "redirect_to": redirect_to,
                "code_challenge": code_challenge,
                "code_challenge_method": "s256",
            })
        )
        webbrowser.open(url_login)

        if not evento_listo.wait(timeout=180):
            return {"ok": False, "error": "Se agoto el tiempo de espera del login. Probá de nuevo."}

        if resultado_callback.get("error") or not resultado_callback.get("code"):
            return {"ok": False, "error": resultado_callback.get("error") or "No se pudo completar el login."}

        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/auth/v1/token?grant_type=pkce",
                data=json.dumps({
                    "auth_code": resultado_callback["code"],
                    "code_verifier": code_verifier,
                }).encode("utf-8"),
                headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                token_datos = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            return {"ok": False, "error": f"No se pudo validar el login: {e}"}

        access_token = token_datos.get("access_token")
        email = (token_datos.get("user") or {}).get("email")
        if not access_token or not email:
            return {"ok": False, "error": "Login incompleto, probá de nuevo."}

        return self._intentar_iniciar_sesion(access_token, token_datos.get("refresh_token"), email)

    def _intentar_iniciar_sesion(self, access_token, refresh_token, email):
        """Registra este equipo en el servidor. Si la cuenta Pro esta activa
        en otro equipo, no aborta: guarda los tokens en self._login_pendiente
        para que el usuario pueda ver "sus dispositivos" y cerrar el otro
        desde aca mismo (sin necesitar sesion propia en este equipo), y
        despues reintentar."""
        device_id = self._id_dispositivo()
        try:
            sesion_datos = self._llamar_rpc(
                "iniciar_sesion",
                {"p_device_id": device_id, "p_device_label": platform.node()},
                access_token=access_token,
            )
        except Exception as e:
            return {"ok": False, "error": f"No se pudo activar la cuenta: {e}"}

        if not sesion_datos.get("ok"):
            self._login_pendiente = None
            return {"ok": False, "error": sesion_datos.get("error") or "No se pudo iniciar sesion."}

        if sesion_datos.get("bloqueado_por_otro_equipo"):
            self._login_pendiente = {"access_token": access_token, "refresh_token": refresh_token, "email": email}
            return {
                "ok": False,
                "bloqueado": True,
                "error": "Tu cuenta CLIPXEL Pro ya esta activa en otro equipo. Cerrala desde aca abajo y volvé a intentar.",
            }

        self._login_pendiente = None
        self._guardar_sesion({
            "access_token": access_token,
            "refresh_token": refresh_token,
            "email": email,
            "plan": sesion_datos.get("plan", "free"),
            "device_id": device_id,
        })
        return {"ok": True, "email": email, "plan": sesion_datos.get("plan", "free")}

    def revalidar_sesion(self):
        """Se llama al arrancar la app (sin abrir el navegador): renueva el
        token con el refresh_token guardado y vuelve a llamar iniciar_sesion
        en el servidor. Asi, si alguien cerro esta sesion remotamente desde
        la web, la app lo detecta y pide loguearse de nuevo en vez de seguir
        confiando ciegamente en lo que quedo guardado en disco."""
        import urllib.request

        sesion = self._cargar_sesion()
        refresh_token = sesion.get("refresh_token")
        if not refresh_token:
            return {"ok": False, "error": "No hay sesion guardada."}

        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
                data=json.dumps({"refresh_token": refresh_token}).encode("utf-8"),
                headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                token_datos = json.loads(resp.read().decode("utf-8"))
            access_token = token_datos["access_token"]
        except Exception:
            self._borrar_sesion()
            return {"ok": False, "error": "Tu sesion expiro. Iniciá sesión de nuevo."}

        device_id = self._id_dispositivo()
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/rpc/iniciar_sesion",
                data=json.dumps({"p_device_id": device_id, "p_device_label": platform.node()}).encode("utf-8"),
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                sesion_datos = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return {"ok": True, "plan": sesion.get("plan", "free")}  # sin internet: seguimos con lo guardado

        if not sesion_datos.get("ok"):
            self._borrar_sesion()
            return {"ok": False, "error": sesion_datos.get("error") or "Se cerro tu sesion."}

        self._guardar_sesion({
            **sesion,
            "access_token": access_token,
            "refresh_token": token_datos.get("refresh_token", refresh_token),
            "plan": sesion_datos.get("plan", "free"),
        })
        return {"ok": True, "plan": sesion_datos.get("plan", "free")}

    def _llamar_rpc(self, nombre, parametros, access_token=None):
        import urllib.request

        if access_token is None:
            access_token = self._cargar_sesion().get("access_token")
        if not access_token:
            return {"ok": False, "error": "No hay sesion activa."}
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/rpc/{nombre}",
            data=json.dumps(parametros).encode("utf-8"),
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def mis_dispositivos(self):
        try:
            dispositivos = self._llamar_rpc("mis_dispositivos", {})
            return {"ok": True, "dispositivos": dispositivos}
        except Exception as e:
            return {"ok": False, "error": f"No se pudo cargar la lista: {e}"}

    def cerrar_sesion_remota(self, device_id):
        try:
            resultado = self._llamar_rpc("cerrar_sesion_dispositivo", {"p_device_id": device_id})
            return resultado
        except Exception as e:
            return {"ok": False, "error": f"No se pudo cerrar esa sesion: {e}"}

    # ---------- gestion de dispositivos desde la pantalla de login bloqueada ----------
    # Cuando iniciar_sesion() devuelve bloqueado_por_otro_equipo, todavia no
    # hay una sesion propia guardada en este equipo (por eso _llamar_rpc no
    # tiene de donde sacar el token). Estos dos metodos usan el access_token
    # que ya conseguimos con Google (guardado en self._login_pendiente) para
    # poder listar y cerrar el otro dispositivo sin necesitar loguearse antes.
    def dispositivos_pendientes(self):
        if not self._login_pendiente:
            return {"ok": False, "error": "No hay un login pendiente."}
        try:
            dispositivos = self._llamar_rpc(
                "mis_dispositivos", {}, access_token=self._login_pendiente["access_token"]
            )
            return {"ok": True, "dispositivos": dispositivos}
        except Exception as e:
            return {"ok": False, "error": f"No se pudo cargar la lista: {e}"}

    def cerrar_sesion_remota_pendiente(self, device_id):
        if not self._login_pendiente:
            return {"ok": False, "error": "No hay un login pendiente."}
        pendiente = self._login_pendiente
        try:
            resultado = self._llamar_rpc(
                "cerrar_sesion_dispositivo", {"p_device_id": device_id}, access_token=pendiente["access_token"]
            )
        except Exception as e:
            return {"ok": False, "error": f"No se pudo cerrar esa sesion: {e}"}
        if not resultado.get("ok"):
            return resultado
        # ya liberamos el otro equipo: reintentamos el login para terminar de activar este.
        return self._intentar_iniciar_sesion(pendiente["access_token"], pendiente["refresh_token"], pendiente["email"])

    def cargar_configuracion(self):
        """Tema, pincel, motor y calidad preferidos, guardados en la cuenta.
        Se aplican solos al iniciar sesion en cualquier PC."""
        try:
            filas = self._llamar_rpc("mi_perfil", {})
            settings = (filas[0] if filas else {}).get("settings") or {}
            return {"ok": True, "settings": settings}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def guardar_configuracion(self, settings):
        try:
            return self._llamar_rpc("guardar_configuracion", {"p_settings": settings})
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------- plantillas (mascaras guardadas en la cuenta) ----------
    def mis_plantillas(self):
        try:
            plantillas = self._llamar_rpc("mis_plantillas", {})
            return {"ok": True, "plantillas": plantillas}
        except Exception as e:
            return {"ok": False, "error": f"No se pudo cargar la lista: {e}"}

    def obtener_plantilla(self, plantilla_id):
        try:
            filas = self._llamar_rpc("obtener_plantilla", {"p_id": plantilla_id})
            if not filas:
                return {"ok": False, "error": "No se encontro la plantilla."}
            return {"ok": True, "plantilla": filas[0]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def guardar_plantilla(self, nombre, mascara_b64, camara_marca=None, camara_modelo=None,
                           ancho_ref=None, alto_ref=None, motor=None, sigma=None):
        try:
            return self._llamar_rpc("guardar_plantilla", {
                "p_nombre": nombre,
                "p_mascara_b64": mascara_b64,
                "p_camara_marca": camara_marca,
                "p_camara_modelo": camara_modelo,
                "p_ancho_ref": ancho_ref,
                "p_alto_ref": alto_ref,
                "p_motor": motor,
                "p_sigma": sigma,
            })
        except Exception as e:
            return {"ok": False, "error": f"No se pudo guardar la plantilla: {e}"}

    def borrar_plantilla(self, plantilla_id):
        try:
            return self._llamar_rpc("borrar_plantilla", {"p_id": plantilla_id})
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------- analitica de uso (liviana, sin contenido de videos) ----------
    def registrar_evento(self, tipo, datos=None):
        try:
            return self._llamar_rpc("registrar_evento", {"p_tipo": tipo, "p_datos": datos or {}})
        except Exception:
            return {"ok": False}  # nunca debe romper el flujo de la app

    # ---------- soporte: diagnostico y reporte de errores ----------
    def _ram_total_gb(self):
        if os.name != "nt":
            return None
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            m = MEMORYSTATUSEX()
            m.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return round(m.ullTotalPhys / (1024 ** 3), 1)
        except Exception:
            return None

    def _version_ffmpeg(self):
        try:
            import subprocess
            salida = subprocess.run(
                [FFMPEG_BIN, "-version"], capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            return (salida.stdout or "").splitlines()[0] if salida.stdout else "desconocida"
        except Exception:
            return "desconocida"

    def diagnostico(self):
        return {
            "clipxel_version": VERSION_APP,
            "sistema_operativo": platform.platform(),
            "cpu": platform.processor() or platform.machine(),
            "nucleos": os.cpu_count(),
            "ram_gb": self._ram_total_gb(),
            "gpu_encoder": self._detectar_motor_gpu(),
            "ffmpeg": self._version_ffmpeg(),
        }

    def elegir_archivo_adjunto(self):
        """Abre el explorador para elegir una captura de pantalla u otro
        archivo para adjuntar al reporte. El usuario saca la captura con la
        herramienta que prefiera (Recorte de Windows, etc.) y la adjunta aca."""
        if not self._ventana:
            return {"ok": False, "error": "Ventana no disponible."}
        resultado = self._ventana.create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=("Imagenes (*.png;*.jpg;*.jpeg)", "Todos los archivos (*.*)"),
        )
        if not resultado:
            return {"ok": False}
        ruta = resultado[0]
        try:
            with open(ruta, "rb") as f:
                datos = f.read()
            if len(datos) > 8 * 1024 * 1024:
                return {"ok": False, "error": "El archivo pesa mas de 8 MB, elegi uno mas chico."}
            b64 = base64.b64encode(datos).decode("ascii")
            return {"ok": True, "nombre": os.path.basename(ruta), "datos_b64": b64}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def reportar_error(self, mensaje, incluir_log=True, adjunto=None):
        """Manda un reporte de soporte (mensaje del usuario + diagnostico +
        log reciente + adjunto opcional) a la Edge Function de Supabase."""
        import urllib.request

        sesion = self._cargar_sesion()
        log_texto = None
        if incluir_log:
            try:
                ruta_log = os.path.join(_carpeta_datos_app(), "debug.log")
                with open(ruta_log, "r", encoding="utf-8", errors="replace") as f:
                    contenido = f.read()
                log_texto = contenido[-20000:]  # ultimas ~20k caracteres alcanzan
            except Exception:
                log_texto = None

        cuerpo = {
            "email": sesion.get("email"),
            "mensaje": mensaje,
            "diagnostico": self.diagnostico(),
            "log": log_texto,
            "adjunto": adjunto,
        }
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/functions/v1/reportar-error",
                data=json.dumps(cuerpo).encode("utf-8"),
                headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                resultado = json.loads(resp.read().decode("utf-8"))
            return resultado
        except Exception as e:
            return {"ok": False, "error": f"No se pudo enviar el reporte: {e}"}

    def _leer_uso(self):
        hoy = datetime.date.today().isoformat()
        try:
            with open(_ruta_datos_usuario("uso.json"), "r", encoding="utf-8") as f:
                datos = json.load(f)
            if datos.get("fecha") != hoy:
                return {"fecha": hoy, "clips": 0}
            return datos
        except Exception:
            return {"fecha": hoy, "clips": 0}

    def _incrementar_uso(self, cantidad=1):
        datos = self._leer_uso()
        datos["clips"] = datos.get("clips", 0) + cantidad
        with open(_ruta_datos_usuario("uso.json"), "w", encoding="utf-8") as f:
            json.dump(datos, f)

    def estado_licencia(self):
        if self._es_pro():
            return {"pro": True, "restantes": None, "limite": None}
        uso = self._leer_uso()
        restantes = max(LIMITE_GRATIS_DIARIO - uso.get("clips", 0), 0)
        return {"pro": False, "restantes": restantes, "limite": LIMITE_GRATIS_DIARIO}


    # ---------- actualizaciones ----------
    def obtener_estado_actualizacion(self):
        """El frontend consulta esto (polling liviano); el chequeo real corre
        en un hilo aparte al arrancar para no bloquear el inicio de la app."""
        with self._actualizacion_lock:
            return dict(self._actualizacion)

    def _revisar_actualizacion_en_fondo(self):
        if os.name != "nt":
            return  # la auto-instalacion solo esta implementada para Windows por ahora
        import urllib.request
        try:
            req = urllib.request.Request(
                URL_ULTIMA_VERSION,
                headers={"Accept": "application/vnd.github+json", "User-Agent": "Clipxel"},
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                datos = json.loads(resp.read().decode("utf-8"))
            version_remota = datos.get("tag_name", "")
            if _version_a_tupla(version_remota) > _version_a_tupla(VERSION_APP):
                descarga_url = None
                for asset in datos.get("assets", []):
                    if asset.get("name") == "Clipxel_Setup.exe":
                        descarga_url = asset.get("browser_download_url")
                        break
                with self._actualizacion_lock:
                    self._actualizacion = {
                        "hay_actualizacion": True,
                        "version_actual": VERSION_APP,
                        "version_nueva": version_remota,
                        "url": datos.get("html_url") or URL_PAGINA_DESCARGA,
                        "descarga_url": descarga_url,
                        "changelog": datos.get("body") or "",
                        "instalando": False,
                    }
                # El instalador se descarga solo en segundo plano (no molesta
                # al usuario) -- salvo que haya un procesamiento en curso, para
                # no competir por ancho de banda/disco con un lote activo (se
                # reintenta cuando termine, ver el finally de
                # _procesar_todo_worker). Pero NUNCA se lanza el instalador ni
                # se cierra la app sola: eso requiere que el usuario confirme
                # explicitamente (ver confirmar_actualizacion), porque cerrar
                # de golpe sin avisar puede pisar trabajo sin guardar.
                if descarga_url:
                    with self._progreso_lock:
                        procesando = not self.progreso.get("terminado", True)
                    if not procesando:
                        self._descargar_instalador_en_fondo(descarga_url)
        except Exception:
            pass  # sin internet o GitHub caido: no molestamos al usuario

    def _descargar_instalador_en_fondo(self, descarga_url):
        """Descarga el instalador nuevo a una carpeta temporal y lo deja
        listo, pero sin lanzarlo ni cerrar la app -- solo marca
        listo_para_instalar=True para que el frontend le pregunte al usuario
        si quiere reiniciar ahora."""
        try:
            import urllib.request
            import tempfile
            ruta_temp = os.path.join(tempfile.gettempdir(), "Clipxel_Setup_actualizacion.exe")
            urllib.request.urlretrieve(descarga_url, ruta_temp)
            with self._actualizacion_lock:
                self._actualizacion["ruta_instalador"] = ruta_temp
                self._actualizacion["listo_para_instalar"] = True
        except Exception as e:
            with self._actualizacion_lock:
                self._actualizacion["error"] = str(e)

    def confirmar_actualizacion(self):
        """El usuario confirmo (desde el dialogo de 'actualizacion lista' o
        la campanita) que quiere cerrar la app ahora para terminar de
        instalar. Si ya se descargo en segundo plano, solo falta lanzar el
        instalador y cerrar; si no, se descarga ahora mismo antes de cerrar."""
        with self._actualizacion_lock:
            ruta_instalador = self._actualizacion.get("ruta_instalador")
            descarga_url = self._actualizacion.get("descarga_url")
        if ruta_instalador and os.path.isfile(ruta_instalador):
            return self._lanzar_instalador_y_cerrar(ruta_instalador)
        if not descarga_url:
            self._revisar_actualizacion_en_fondo()
            with self._actualizacion_lock:
                descarga_url = self._actualizacion.get("descarga_url")
        if not descarga_url:
            return {"ok": False, "error": "No hay una URL de descarga disponible todavia."}
        return self._descargar_e_instalar(descarga_url)

    def _lanzar_instalador_y_cerrar(self, ruta_instalador):
        try:
            with self._actualizacion_lock:
                self._actualizacion["instalando"] = True
            import subprocess
            subprocess.Popen(
                [ruta_instalador, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"],
                close_fds=True,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            threading.Thread(target=self._cerrar_para_actualizar, daemon=True).start()
            return {"ok": True}
        except Exception as e:
            with self._actualizacion_lock:
                self._actualizacion["instalando"] = False
                self._actualizacion["error"] = str(e)
            return {"ok": False, "error": str(e)}

    def _descargar_e_instalar(self, descarga_url):
        """Descarga el instalador nuevo y lo lanza en modo silencioso; el
        instalador reemplaza esta misma instalacion (mismo AppId => actualizacion
        in-place) y vuelve a abrir la app solo. La licencia no se pierde porque
        vive en %LOCALAPPDATA%\\Clipxel, fuera de la carpeta de instalacion.
        Devuelve {"ok": bool, "error": str|None} -- el llamador debe propagarlo,
        nunca asumir que salio bien."""
        try:
            with self._actualizacion_lock:
                self._actualizacion["instalando"] = True

            import urllib.request
            import tempfile
            ruta_temp = os.path.join(tempfile.gettempdir(), "Clipxel_Setup_actualizacion.exe")
            urllib.request.urlretrieve(descarga_url, ruta_temp)

            import subprocess
            subprocess.Popen(
                [ruta_temp, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"],
                close_fds=True,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            threading.Thread(target=self._cerrar_para_actualizar, daemon=True).start()
            return {"ok": True}
        except Exception as e:
            with self._actualizacion_lock:
                self._actualizacion["instalando"] = False
                self._actualizacion["error"] = str(e)
            return {"ok": False, "error": str(e)}

    def instalar_actualizacion(self):
        """Disparador manual (botón de la campanita o del dialogo de
        actualizacion lista): el usuario ya confirmo explicitamente que
        quiere cerrar la app ahora para actualizar."""
        with self._actualizacion_lock:
            ya_instalando = self._actualizacion.get("instalando")
        if ya_instalando:
            return {"ok": True}
        return self.confirmar_actualizacion()

    def _cerrar_para_actualizar(self):
        import time
        time.sleep(1.2)  # le da tiempo al frontend a mostrar el mensaje antes de cerrar
        os._exit(0)

    # ---------- paso clip ----------
    # Los dialogos nativos de Windows necesitan correr en el mismo hilo que
    # pywebview ya usa para las llamadas js_api (por temas de threading de COM).
    # Se probo moverlo a un hilo propio para evitar colgarse y broque el
    # dialogo silenciosamente -- se vuelve a la forma simple, que es la que
    # ya se confirmo funcionando antes.
    def elegir_clips(self):
        archivos = self._ventana.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=True,
            file_types=("Videos (*.mp4;*.mov;*.mxf;*.avi)", "Todos los archivos (*.*)"),
        )
        return list(archivos) if archivos else []

    def obtener_carpeta_salida(self):
        return {"carpeta": _leer_carpeta_salida_personalizada()}

    def elegir_carpeta_salida(self):
        resultado = self._ventana.create_file_dialog(webview.FOLDER_DIALOG)
        if not resultado:
            return {"carpeta": _leer_carpeta_salida_personalizada()}
        carpeta = resultado[0]
        _guardar_carpeta_salida_personalizada(carpeta)
        return {"carpeta": carpeta}

    def restablecer_carpeta_salida(self):
        _guardar_carpeta_salida_personalizada(None)
        return {"carpeta": None}

    def obtener_frame_y_metadata(self, ruta_clip):
        try:
            info_meta = metadata_camara.leer_metadata_camara(FFPROBE_BIN, ruta_clip)
        except Exception:
            info_meta = None

        try:
            import subprocess
            ruta_tmp = os.path.join(os.path.dirname(ruta_clip), "_pixelclean_frame.png")
            info = motores._info_basica(FFPROBE_BIN, ruta_clip)
            segundo = (info["duracion_seg"] / 2) if info["duracion_seg"] else 1.0
            subprocess.run([FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
                             "-ss", str(segundo), "-i", ruta_clip, "-frames:v", "1", ruta_tmp],
                            capture_output=True, timeout=30,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            img = Image.open(ruta_tmp).convert("RGB")
            self._frame_actual = img
            os.remove(ruta_tmp)
            return {
                "frame_b64": _pil_a_b64(img), "ancho": img.width, "alto": img.height,
                "metadata": info_meta or {}, "duracion_seg": info.get("duracion_seg") or 0,
            }
        except Exception as e:
            return {"frame_b64": None, "ancho": 0, "alto": 0, "metadata": info_meta or {}, "duracion_seg": 0, "error": str(e)}

    def obtener_metadata_clip(self, ruta_clip):
        """Metadata de un clip puntual de la lista, sin tocar self._frame_actual
        (que es el cuadro "de referencia" sobre el que se pinta la mascara) --
        para poder mostrar la info de cualquier clip que el usuario elija ver
        sin afectar el flujo de mascara/render."""
        try:
            return {"metadata": metadata_camara.leer_metadata_camara(FFPROBE_BIN, ruta_clip) or {}}
        except Exception as e:
            return {"metadata": {}, "error": str(e)}

    def obtener_frame_en(self, ruta_clip, segundo):
        """Pide el cuadro de un instante puntual del clip (para el scrubber del
        paso Mascara): sirve para buscar a mano un momento donde el defecto se
        vea mejor, en vez de quedarse siempre con el cuadro del medio del clip."""
        try:
            import subprocess
            import tempfile
            ruta_tmp = os.path.join(tempfile.gettempdir(), f"_pixelclean_scrub_{os.getpid()}.png")
            subprocess.run([FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
                             "-ss", str(max(float(segundo), 0)), "-i", ruta_clip, "-frames:v", "1", ruta_tmp],
                            capture_output=True, timeout=15,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if not os.path.isfile(ruta_tmp):
                return {"ok": False, "error": "No se pudo leer ese instante del clip."}
            img = Image.open(ruta_tmp).convert("RGB")
            self._frame_actual = img  # el resto del flujo (mascara, preview) usa este mismo cuadro
            os.remove(ruta_tmp)
            return {"ok": True, "frame_b64": _pil_a_b64(img)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def elegir_mascara_png(self, ancho, alto):
        archivo = self._ventana.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False,
            file_types=("Imagenes (*.png;*.jpg;*.jpeg)", "Todos los archivos (*.*)"),
        )
        if not archivo:
            return None
        try:
            img = Image.open(archivo[0]).convert("RGB")
            arr = np.asarray(img).astype(np.int16)
            r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
            verde = (g > r + GREEN_THRESHOLD) & (g > b + GREEN_THRESHOLD)
            if not verde.any():
                gris = np.asarray(Image.open(archivo[0]).convert("L"))
                verde = gris > 127
            rgba = np.zeros((verde.shape[0], verde.shape[1], 4), dtype=np.uint8)
            rgba[verde] = [58, 160, 255, 255]
            salida = Image.fromarray(rgba, mode="RGBA").resize((ancho, alto))
            return _pil_a_b64(salida)
        except Exception:
            return None

    def guardar_mascara_png(self, mascara_b64, nombre_sugerido=None):
        archivo = self._ventana.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=(nombre_sugerido or "mascara") + ".png",
            file_types=("Imagen PNG (*.png)",),
        )
        if not archivo:
            return {"ok": False}
        ruta = archivo if isinstance(archivo, str) else archivo[0]
        try:
            # Se exporta en blanco y negro puro (segun el canal alfa: pintado
            # = blanco, sin pintar = negro) en vez del azul con transparencia
            # que se usa en pantalla -- asi al volver a importarla no depende
            # de ninguna heuristica de color, es directo y sin ambiguedad.
            alfa = np.asarray(_b64_a_pil(mascara_b64).convert("RGBA"))[..., 3]
            blanco_y_negro = np.where(alfa > 0, 255, 0).astype(np.uint8)
            Image.fromarray(blanco_y_negro, mode="L").save(ruta)
            return {"ok": True, "ruta": ruta}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------- vista previa en vivo ----------
    def render_preview(self, motor_id, mascara_b64, sigma):
        if self._frame_actual is None:
            return None
        try:
            mascara_rgba = np.asarray(_b64_a_pil(mascara_b64).convert("RGBA").resize(self._frame_actual.size))
            mascara_arr = mascara_rgba[..., 3]
            ys, xs = np.where(mascara_arr > 20)
            if len(xs) == 0:
                return None
            pad = 60
            frame = np.asarray(self._frame_actual)
            x0, x1 = max(int(xs.min()) - pad, 0), min(int(xs.max()) + pad, frame.shape[1])
            y0, y1 = max(int(ys.min()) - pad, 0), min(int(ys.max()) + pad, frame.shape[0])
            crop = frame[y0:y1, x0:x1]
            mascara_crop = mascara_arr[y0:y1, x0:x1]
            reparado = reparar_crop_preview(motor_id, crop, mascara_crop, sigma)
            return {
                "antes_b64": _pil_a_b64(Image.fromarray(crop)),
                "despues_b64": _pil_a_b64(Image.fromarray(reparado)),
            }
        except Exception:
            traceback.print_exc()
            return None

    # ---------- procesar ----------
    # Nota: las actualizaciones de progreso se guardan aca y el frontend las consulta
    # activamente (polling) en vez de que Python se las empuje via evaluate_js desde un
    # hilo en segundo plano -- eso ultimo resulto poco confiable en esta combinacion
    # concreta de pywebview + WinForms + WebView2 (errores de threading en el log).
    def procesar_todo(self, payload):
        try:
            total = len(payload["clips"])
            if not self._es_pro():
                uso = self._leer_uso()
                restantes = max(LIMITE_GRATIS_DIARIO - uso.get("clips", 0), 0)
                if total > restantes:
                    return {"ok": False, "error": "limite_gratis", "restantes": restantes, "limite": LIMITE_GRATIS_DIARIO}
            self._evento_cancelar.clear()
            with self._progreso_lock:
                self.progreso = {
                    "completados": 0, "total": total, "por_clip": [0.0] * total,
                    "nombres": [os.path.basename(c) for c in payload["clips"]],
                    "rutas_salida": [None] * total,
                    "logs": [], "terminado": False,
                }
            threading.Thread(target=self._procesar_todo_worker, args=(payload,), daemon=True).start()
            threading.Thread(target=self.registrar_evento, args=("proceso_lote", {
                "so": platform.system(),
                "motor": payload.get("motor"),
                "resolucion": payload.get("resolucion"),
                "cantidad_clips": total,
            }), daemon=True).start()
            return {"ok": True}
        except Exception as e:
            with self._progreso_lock:
                self.progreso = {"completados": 0, "total": 0, "por_clip": [], "terminado": True,
                                  "logs": [{"mensaje": f"ERROR al iniciar: {e}", "ok": False}]}
            return {"ok": False, "error": str(e)}

    def cancelar_procesamiento(self):
        self._evento_cancelar.set()
        self._agregar_log("Cancelando... (se corta al terminar el paso actual del clip en curso)", False)
        return {"ok": True}

    def mostrar_en_carpeta(self, ruta):
        try:
            import subprocess
            if not os.path.isfile(ruta):
                return {"ok": False, "error": "El archivo ya no esta ahi."}
            if os.name == "nt":
                # Con una lista, subprocess pone comillas alrededor de TODO
                # "/select,C:\ruta con espacios\archivo.mp4" (por el espacio
                # en la ruta) -- explorer.exe no entiende eso y abre la
                # carpeta por defecto (Documentos) en vez de la real. Hay
                # que pasarlo como un solo string por shell, con la comilla
                # solo alrededor de la ruta, como se escribiria a mano.
                subprocess.run(f'explorer /select,"{ruta}"', shell=True,
                                creationflags=subprocess.CREATE_NO_WINDOW)
            elif sys.platform == "darwin":
                subprocess.run(["open", "-R", ruta])
            else:
                subprocess.run(["xdg-open", os.path.dirname(ruta)])
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _agregar_log(self, mensaje, ok):
        with self._progreso_lock:
            self.progreso["logs"].append({"mensaje": mensaje, "ok": ok})

    # ---------- vista previa en vivo durante el render (de prueba) ----------
    # Muestreo periodico y en baja resolucion, solo para ver "por donde viene"
    # el lote -- no es el cuadro exacto que esta escribiendo ffmpeg (eso requeriria
    # leer el archivo de salida a medio escribir, fragil), sino el mismo calculo
    # de reparar_crop_preview aplicado al cuadro de origen mas cercano al avance
    # actual. Nunca debe interrumpir el procesamiento real si algo falla.
    def _actualizar_preview_render(self, ruta_clip, frac, motor_id, mascara_rgba_arr, sigma):
        ahora = time.time()
        with self._preview_lock:
            if ahora - self._preview_render_ultima < 2.0:
                return
            self._preview_render_ultima = ahora
        # OJO: esto tiene que correr en un hilo aparte, nunca en linea. Esta
        # funcion la llama el callback de progreso, que corre en el mismo hilo
        # que va leyendo la salida de ffmpeg del render real -- si acá adentro
        # se bloquea 1-2s haciendo su propio ffmpeg + proceso de imagen, se deja
        # de leer el stdout del ffmpeg real, su pipe se llena y HACE QUE EL
        # RENDER REAL SE FRENE esperando que alguien lea. Un render que antes
        # tardaba X terminaba tardando el doble o mas por esto.
        threading.Thread(
            target=self._generar_preview_render, args=(ruta_clip, frac, motor_id, mascara_rgba_arr, sigma),
            daemon=True,
        ).start()

    def _generar_preview_render(self, ruta_clip, frac, motor_id, mascara_rgba_arr, sigma):
        try:
            import subprocess
            import tempfile
            info = motores._info_basica(FFPROBE_BIN, ruta_clip)
            duracion = info.get("duracion_seg") or 1.0
            segundo = max(min(frac, 0.98), 0.0) * duracion
            ruta_tmp = os.path.join(
                tempfile.gettempdir(), f"_pixelclean_preview_{os.getpid()}_{threading.get_ident()}.png")
            subprocess.run([FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
                             "-ss", str(segundo), "-i", ruta_clip, "-frames:v", "1", ruta_tmp],
                            capture_output=True, timeout=15,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if not os.path.isfile(ruta_tmp):
                return
            frame = np.asarray(Image.open(ruta_tmp).convert("RGB"))
            os.remove(ruta_tmp)
            mascara_rs = np.asarray(Image.fromarray(mascara_rgba_arr, mode="RGBA")
                                     .resize((frame.shape[1], frame.shape[0])))
            mascara_alpha = mascara_rs[..., 3]
            # cuadro completo, no solo el recorte de la mascara -- ahora que
            # esto corre en su propio hilo (ver _actualizar_preview_render) ya
            # no hay costo de bloquear el render real por hacerlo mas grande.
            reparado = reparar_crop_preview(motor_id, frame, mascara_alpha, sigma)
            img_out = Image.fromarray(reparado)
            img_out.thumbnail((720, 720))  # mantiene relacion de aspecto original, solo limita el lado mas largo
            with self._preview_lock:
                self._preview_render_b64 = _pil_a_b64(img_out)
        except Exception:
            pass

    def _procesar_todo_worker(self, payload):
        clips = payload["clips"]
        try:
            # Por defecto cada clip se exporta a una carpeta "Clipxel"
            # junto al medio original (asi si el lote mezcla clips de
            # distintas carpetas, cada uno sale al lado del suyo). Si el
            # usuario eligio una carpeta fija (ver elegir_carpeta_salida),
            # esa se usa para todo el lote en cambio.
            carpeta_salida_fija = _leer_carpeta_salida_personalizada()

            # Mascara "de referencia", tal como se dibujo sobre el frame de
            # muestra (que puede ser horizontal o vertical). Cada clip del
            # lote puede tener otra orientacion/resolucion (misma camara,
            # pero algunas tomas horizontales y otras verticales, o
            # resoluciones distintas) -- eso se adapta por clip mas abajo.
            mascara_rgba = _b64_a_pil(payload["mascara_b64"]).convert("RGBA").resize(self._frame_actual.size)

            motor_gpu = self._detectar_motor_gpu()
            nombres_gpu = {"nvenc": "NVIDIA (NVENC)", "qsv": "Intel Quick Sync", "amf": "AMD (AMF)",
                           "videotoolbox": "Apple (VideoToolbox)"}
            self._agregar_log(
                f"Codificando con GPU: {nombres_gpu.get(motor_gpu, motor_gpu)}." if motor_gpu
                else "Codificando con CPU (no se detecto GPU compatible).", True)

            preset_info = PRESETS_VELOCIDAD[payload["velocidad"]]
            parametros = {
                "sigma_blur": payload["sigma"], "preset_info": preset_info,
                "modo_calidad": payload["calidad"], "resolucion_objetivo": RESOLUCIONES[payload["resolucion"]],
                "motor_gpu": motor_gpu, "radio_inpaint": 5, "metodo": "telea", "zoom_padding": 40,
                "evento_cancelar": self._evento_cancelar,
            }
            motor_fn = motores.MOTORES[payload["motor"]]
            total = len(clips)

            for idx, clip in enumerate(clips):
                if self._evento_cancelar.is_set():
                    self._agregar_log("Cancelado por el usuario.", False)
                    break
                carpeta_base = carpeta_salida_fija or os.path.dirname(clip)
                carpeta_salida = os.path.join(carpeta_base, "Clipxel")
                os.makedirs(carpeta_salida, exist_ok=True)
                nombre = os.path.splitext(os.path.basename(clip))[0]
                ext = os.path.splitext(clip)[1] or ".mp4"
                ruta_salida = os.path.join(carpeta_salida, nombre + ext)

                info_clip = motores._info_basica(FFPROBE_BIN, clip)
                ancho_clip, alto_clip = info_clip.get("ancho"), info_clip.get("alto")
                mascara_clip, roto = _adaptar_mascara_a_clip(mascara_rgba, ancho_clip, alto_clip)
                if roto:
                    self._agregar_log(
                        f"{os.path.basename(clip)}: orientacion distinta a la de referencia, "
                        f"rotando la mascara ({roto}).", True)
                mascara_l = Image.fromarray(np.asarray(mascara_clip)[..., 3], mode="L")
                # La mascara en blanco y negro solo hace falta mientras dura el
                # render de este clip (los motores la leen del disco) -- no
                # tiene sentido dejarla al lado del video ya exportado, asi que
                # se guarda en una carpeta temporal y se borra apenas termina
                # este clip (haya salido bien o mal).
                mascara_bn_path = os.path.join(
                    tempfile.gettempdir(), f"_pixelclean_mascara_{os.getpid()}_{idx}.png")
                mascara_l.save(mascara_bn_path)
                mascara_rgba_arr = np.asarray(mascara_clip)

                def callback(frac, i=idx, clip=clip):
                    with self._progreso_lock:
                        self.progreso["por_clip"][i] = frac
                    self._actualizar_preview_render(clip, frac, payload["motor"], mascara_rgba_arr, payload["sigma"])

                try:
                    exito, resultado = motor_fn(FFMPEG_BIN, FFPROBE_BIN, clip, mascara_bn_path, ruta_salida,
                                                 parametros, callback)
                    if not exito and parametros["motor_gpu"] and resultado != "Cancelado por el usuario.":
                        # El encoder de GPU puede rechazar un clip puntual por
                        # motivos que el mini-render de deteccion no cubre
                        # (resolucion, formato, etc.) -- en vez de perder el
                        # clip entero, se reintenta ese clip por CPU antes de
                        # darlo por fallido.
                        self._agregar_log(
                            f"{os.path.basename(clip)}: fallo el encoder de GPU, reintentando por CPU...", False)
                        parametros_cpu = dict(parametros, motor_gpu=None)
                        exito, resultado = motor_fn(FFMPEG_BIN, FFPROBE_BIN, clip, mascara_bn_path, ruta_salida,
                                                     parametros_cpu, callback)
                finally:
                    try:
                        os.remove(mascara_bn_path)
                    except OSError:
                        pass
                mensaje = (f"OK: {os.path.basename(clip)} -> {os.path.basename(resultado)}" if exito
                           else f"ERROR: {os.path.basename(clip)} -> {resultado}")
                self._agregar_log(mensaje, exito)
                if exito and not self._es_pro():
                    self._incrementar_uso(1)
                with self._progreso_lock:
                    self.progreso["completados"] = idx + 1
                    self.progreso["por_clip"][idx] = 1.0
                    if exito:
                        self.progreso["rutas_salida"][idx] = resultado

            if carpeta_salida_fija:
                self._agregar_log(f"Listo. Carpeta de salida: {carpeta_salida}", True)
            else:
                self._agregar_log('Listo. Cada clip se exporto en una carpeta "Clipxel" junto al original.', True)
        except Exception:
            self._agregar_log("ERROR inesperado:\n" + traceback.format_exc(), False)
        finally:
            with self._progreso_lock:
                self.progreso["terminado"] = True
            with self._actualizacion_lock:
                pendiente = (
                    self._actualizacion.get("hay_actualizacion")
                    and self._actualizacion.get("descarga_url")
                    and not self._actualizacion.get("instalando")
                )
                descarga_url = self._actualizacion.get("descarga_url")
            if pendiente:
                self._descargar_e_instalar(descarga_url)


def _personalizar_titlebar_windows(titulo_ventana):
    """Pinta la barra de titulo nativa de Windows (fondo, texto y borde) del
    mismo color oscuro que usa la app por defecto, en vez del blanco/gris de
    Windows. La API de Windows (DWM) solo permite un color solido para esto,
    no un degradado -- eso requeriria sacar el marco nativo por completo y
    dibujar una barra de titulo propia en HTML, un cambio mucho mas grande.
    Silenciosamente no hace nada en versiones de Windows que no lo soporten
    (hace falta Windows 11 22H2 o mas nuevo para el color de la barra; en
    versiones anteriores de Windows 10/11 como mucho se pone en "modo oscuro"
    generico)."""
    if os.name != "nt":
        return
    try:
        import ctypes
        hwnd = None
        for _ in range(100):  # hasta ~10s por si la ventana nativa todavia no existe
            hwnd = ctypes.windll.user32.FindWindowW(None, titulo_ventana)
            if hwnd:
                break
            time.sleep(0.1)
        if not hwnd:
            return
        dwmapi = ctypes.windll.dwmapi
        DWMWA_USE_IMMERSIVE_DARK_MODE = 20
        DWMWA_BORDER_COLOR = 34
        DWMWA_CAPTION_COLOR = 35
        DWMWA_TEXT_COLOR = 36
        oscuro = ctypes.c_int(1)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(oscuro), ctypes.sizeof(oscuro))
        # COLORREF de Windows es 0x00BBGGRR, al reves de un hex web normal.
        color_fondo = ctypes.c_int(0x00100C0A)  # #0a0c10 (fondo oscuro por defecto de la app)
        color_texto = ctypes.c_int(0x00F7F3F2)  # #f2f3f7 (texto claro por defecto de la app)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ctypes.byref(color_fondo), ctypes.sizeof(color_fondo))
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, ctypes.byref(color_texto), ctypes.sizeof(color_texto))
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ctypes.byref(color_fondo), ctypes.sizeof(color_fondo))
    except Exception:
        logging.getLogger().exception("No se pudo personalizar la barra de titulo")


def _iniciar_servidor(api):
    """Un unico servidor HTTP que sirve los archivos estaticos (web/) y el endpoint
    de progreso desde el mismo origen. El puente js_api de pywebview demostro ser
    poco confiable para llamadas repetidas/rapidas en esta combinacion de tecnologias;
    y usar un segundo servidor en otro puerto para el progreso metia de vuelta un
    pedido cruzado (distinto puerto = distinto origen) que tambien fallaba. Con todo
    en el mismo servidor, el fetch del frontend queda siempre same-origin."""
    from http.server import SimpleHTTPRequestHandler

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=CARPETA_WEB, **kwargs)

        def end_headers(self):
            # WebView2/Chromium a veces sirve el index.html, app.js o style.css
            # cacheados aunque el archivo en disco ya cambio (sobre todo entre
            # reinicios de la app durante desarrollo). Sin esto, un Ctrl+R puede
            # seguir mostrando una version vieja del frontend.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _responder_json(self, datos):
            cuerpo = json.dumps(datos).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.end_headers()
            self.wfile.write(cuerpo)

        def do_GET(self):
            ruta = self.path.split("?")[0]
            if ruta == "/progreso":
                with api._progreso_lock:
                    self._responder_json(api.progreso)
            elif ruta == "/preview_render":
                with api._preview_lock:
                    self._responder_json({"preview_b64": api._preview_render_b64})
            elif ruta == "/clip_video":
                self._servir_video()
            else:
                super().do_GET()

        def _servir_video(self):
            """Streamea el clip original directo desde disco (con soporte de
            Range) para que el <video> del paso Mascara pueda reproducir y
            buscar posiciones al instante, sin pasar por Python en cada
            movimiento -- eso era lo que hacia lento al scrubber anterior."""
            query = urllib.parse.urlsplit(self.path).query
            ruta_video = urllib.parse.parse_qs(query).get("path", [None])[0]
            if ruta_video:
                ruta_video = urllib.parse.unquote(ruta_video)
            if not ruta_video or not os.path.isfile(ruta_video):
                self.send_error(404, "Clip no encontrado")
                return

            tamano = os.path.getsize(ruta_video)
            tipo = mimetypes.guess_type(ruta_video)[0] or "video/mp4"
            rango = self.headers.get("Range")

            if rango:
                unidad, _, valores = rango.partition("=")
                inicio_txt, _, fin_txt = valores.partition("-")
                inicio = int(inicio_txt) if inicio_txt else 0
                fin = int(fin_txt) if fin_txt else tamano - 1
                fin = min(fin, tamano - 1)
                largo = max(fin - inicio + 1, 0)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {inicio}-{fin}/{tamano}")
            else:
                inicio, largo = 0, tamano
                self.send_response(200)

            self.send_header("Content-Type", tipo)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(largo))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            try:
                with open(ruta_video, "rb") as f:
                    f.seek(inicio)
                    restante = largo
                    while restante > 0:
                        trozo = f.read(min(262144, restante))
                        if not trozo:
                            break
                        self.wfile.write(trozo)
                        restante -= len(trozo)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass  # el usuario siguio moviendo el scrubber y corto el pedido anterior; normal

        def log_message(self, formato, *args):
            pass

    servidor = HTTPServer(("127.0.0.1", 0), Handler)
    puerto = servidor.server_address[1]
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return puerto


def main():
    carpeta_log = _carpeta_datos_app()
    logging.basicConfig(
        filename=os.path.join(carpeta_log, "debug.log"), filemode="w",
        level=logging.DEBUG, format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    logging.getLogger().info("arranque: cwd=%s frozen=%s meipass=%s exe=%s",
                              os.getcwd(), getattr(sys, "frozen", False),
                              getattr(sys, "_MEIPASS", None), sys.executable)
    # ojo: NO forzar DPI-awareness (SetProcessDpiAwareness) a nivel de proceso aca.
    # WebView2/Chromium ya maneja el escalado de pantalla por su cuenta de forma
    # correcta (via devicePixelRatio); si el proceso host tambien se declara
    # DPI-aware, las dos capas terminan compensando el escalado por separado y
    # las coordenadas del mouse le llegan mal a la pagina (pintar en el lugar
    # equivocado). Se probo explicitamente y empeoraba las cosas.
    api = Api()
    threading.Thread(target=api._revisar_actualizacion_en_fondo, daemon=True).start()
    puerto = _iniciar_servidor(api)
    titulo_ventana = "CLIPXEL Studio - Reparador de pixeles quemados"
    ventana = webview.create_window(
        titulo_ventana,
        f"http://127.0.0.1:{puerto}/index.html",
        js_api=api, width=1280, height=820, min_size=(1040, 700),
        background_color="#0b0d12", maximized=True,
    )
    api.set_ventana(ventana)
    threading.Thread(target=_personalizar_titlebar_windows, args=(titulo_ventana,), daemon=True).start()

    def _al_soltar_archivos(e):
        # El navegador nunca expone la ruta real de un archivo soltado por
        # seguridad; pywebview la inyecta como "pywebviewFullPath" pero SOLO
        # para listeners de drop registrados por esta via (window.dom), no
        # para un addEventListener comun hecho en el JS de la pagina -- por
        # eso el drag&drop hecho solo en JS nunca funcionaba.
        try:
            archivos = (e.get("dataTransfer") or {}).get("files", [])
            rutas = [f["pywebviewFullPath"] for f in archivos if f.get("pywebviewFullPath")]
            rutas = [r for r in rutas if r.lower().endswith((".mp4", ".mov", ".mxf", ".avi", ".m4v", ".mkv"))]
            if rutas:
                ventana.evaluate_js(f"window.agregarClipsDesdeDrop({json.dumps(rutas)})")
        except Exception:
            logging.getLogger().exception("Error al procesar archivos soltados")

    def _configurar_drag_and_drop():
        try:
            ventana.dom.document.events.dragover += DOMEventHandler(lambda e: None, prevent_default=True)
            ventana.dom.document.events.drop += DOMEventHandler(_al_soltar_archivos, prevent_default=True)
        except Exception:
            logging.getLogger().exception("No se pudo registrar drag and drop nativo")

    ventana.events.loaded += _configurar_drag_and_drop
    if os.name == "nt":
        # Instalado en Program Files, la carpeta del .exe queda de solo-lectura para
        # usuarios sin admin. Si no se fija storage_path, WebView2 intenta crear su
        # carpeta de perfil ahi mismo (o en un temp dir que pywebview borra al toque),
        # falla en silencio (build sin consola) y la ventana se queda en negro para
        # siempre en el background_color de arriba. Se fuerza una carpeta escribible
        # por-usuario en LOCALAPPDATA. En macOS (backend Cocoa/WebKit) esto no aplica.
        carpeta_datos = os.path.join(_carpeta_datos_app(), "webview2_data")
        os.makedirs(carpeta_datos, exist_ok=True)
        webview.start(private_mode=False, storage_path=carpeta_datos)
    else:
        webview.start(private_mode=False)


if __name__ == "__main__":
    main()
