# Plan: Clipxel Inpaint — plugin de efecto para Premiere Pro

## Contexto
El SDK real (Premiere Pro 27.0 C++ SDK, subido por el usuario) ya fue inspeccionado.
No se vendorea en este repo por licencia de Adobe — queda en la máquina de quien compile.

## Por qué hay que compilar esto en Windows (no en un sandbox Linux)
- El build en Windows depende de `PiPLTool` / `Resources/Win/Cnvtpipl.exe`, un
  ejecutable de Windows que convierte el recurso `.r` del plugin a `.rcp` — no corre
  fuera de Windows.
- El `.vcxproj` de los ejemplos espera variables de entorno `AE_SDK_BASE_PATH` y
  `BOOST_BASE_PATH`, y linkea con el toolchain de MSVC.
- Hace falta Premiere Pro instalado para cargar y probar el `.aex`/plugin de verdad.

## Punto de partida: sample "Vignette" (Examples/Projects/GPUVideoFilter/Vignette)
Es el ejemplo más simple y moderno (soporta 8u/32f, VUYA/BGRA, Premiere y AE).
Estructura a copiar/adaptar:
- `Vignette.h` → parámetros, structs de pixel, firma de `EntryPointFunc`.
- `Vignette_CPU.cpp` → dispatcher (`PF_Cmd_GLOBAL_SETUP`, `PARAMS_SETUP`,
  `SMART_PRE_RENDER`, `SMART_RENDER`), `ParamsSetup`, render por pixel.
- `Vignette.r` → PiPL (nombre, categoría, entry point, flags).
- Carpeta `Win/` (`.sln`/`.vcxproj`) y `Mac/` (`.xcodeproj`) como base de proyecto.

**Para v1: ignorar los archivos de GPU** (`.cl`, `.cu`, `.hlsl`, `.metal`,
`VignetteGPU.h`, `Vignette_GPU.cpp`). Sin declarar flags de soporte GPU, Premiere
usa el render por CPU automáticamente — más simple, suficiente para probar que
el plugin carga y corrige en vivo.

## Diseño del efecto "Clipxel Inpaint"
Parámetros (ver `PF_ADD_*` en `ParamsSetup` de Vignette_CPU.cpp como ejemplo):
1. **Botón "Cargar máscara PNG..."** (`PF_Param_BUTTON`) — al clickear, abre un
   diálogo de archivos nativo:
   - Windows: `GetOpenFileNameW` (comdlg32).
   - Mac: `NSOpenPanel` (Objective-C++, requiere un .mm aparte).
   El path elegido se guarda en un parámetro `PF_Param_ARBITRARY_DATA` (struct
   con un `char path[260]` o similar) para que persista con el proyecto.
2. **Slider "Difuminado"** (sigma del blur, igual al motor `blur` que ya existe
   en `motores_reparacion.py` de la app de escritorio — mismo concepto, portado
   a C++: blend de Gaussian blur solo en la zona de la máscara).
3. (Opcional v2) Slider "Opacidad" / checkbox "Invertir máscara".

## Carga del PNG
No vendorear nada de Adobe ni reinventar un decoder propio desde cero: usar
**lodepng** (dominio público / zlib license, un solo .h/.cpp, sin dependencias)
para decodificar el PNG de la máscara a un buffer RGBA en memoria. Evita código
nativo de imagen distinto por plataforma.

## Render (CPU, `PF_Cmd_SMART_RENDER`)
- Igual que `Vignette_CPU.cpp`: iterar el buffer de salida (`PF_EffectWorld`),
  en el bounding box de la máscara (donde alpha/luma de la máscara > umbral),
  mezclar el pixel original con una versión blureada (box blur separable simple,
  no hace falta ser exacto a Gaussian), ponderado por el valor de la máscara en
  ese pixel (0-255 → 0.0-1.0).
- Soportar al menos los pixel formats que Premiere declara en `GlobalSetup` del
  ejemplo: `PrPixelFormat_VUYA_4444_8u` y `PrPixelFormat_BGRA_4444_8u` primero
  (8-bit, más simple), 32f después si da el tiempo.

## No modifica el archivo original
Por diseño: es un efecto de clip (como cualquier otro de Premiere), vive en la
línea de tiempo, se renderiza al vuelo en el Programa Monitor. El media original
en disco nunca se toca — es exactamente como pidió el usuario.

## Cómo seguir (en la sesión local de Windows)
1. Clonar `clipxel/clipxel.github.io`.
2. Bajar el SDK de Adobe (ya lo tiene el usuario en Descargas) y definir
   `AE_SDK_BASE_PATH` apuntando a la carpeta del SDK.
3. Copiar `Examples/Projects/GPUVideoFilter/Vignette` como base, renombrar a
   `ClipxelInpaint`, y aplicar el diseño de arriba.
4. Compilar con el `.sln` (Visual Studio). Si falta `BOOST_BASE_PATH`, revisar
   si el ejemplo elegido realmente lo necesita (Vignette puede no requerirlo —
   confirmar al abrir el .vcxproj).
5. Copiar el `.aex` resultante a
   `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\` y abrir Premiere.
6. Verificar que aparezca en el panel de Efectos, bajo la categoría definida en
   el PiPL, y que al aplicarlo sobre un clip permita elegir el PNG y vea el
   resultado en vivo sin tocar el archivo original.

## Pendiente de este lado (sandbox Linux, sin Premiere/Windows real)
No pude compilar ni probar nada de esto — todo lo anterior es diseño/plan a
partir de los headers y el ejemplo reales del SDK, sin verificar en un build.
