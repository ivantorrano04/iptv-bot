import requests
import json
import time
import os
import socket

# Cargar .env si existe
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, val = line.split('=', 1)
                os.environ.setdefault(key.strip(), val.strip())

# --- CONFIGURACIÓN ---
# Pon tu token de GitHub en variable de entorno o edítalo aquí (NO subir a repos públicos)
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GIST_ID = "8028547c786162756e9f5b9ced06c3df"
ARCHIVO_CANALES = "canales.txt"

# Cambia esto a la URL de tu servidor en Render cuando lo despliegues
# Ejemplo: "https://mi-iptv-bot.onrender.com"
# Déjalo vacío para usar tu IP local
CLOUD_SERVER_URL = "https://iptv-bot-kk5s.onrender.com"

SERVER_PORT = 3000

def get_local_ip():
    """Obtiene la IP local de la máquina para que otros dispositivos la alcancen"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "localhost"

def leer_canales(archivo):
    """Lee canales.txt y devuelve lista de {name, code, group}"""
    canales = []
    with open(archivo, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split(',')
            name = parts[0].strip()
            code = parts[1].strip() if len(parts) > 1 else 'es'
            group = parts[2].strip() if len(parts) > 2 else 'General'
            canales.append({'name': name, 'code': code, 'group': group})
    return canales

def generar_m3u8(canales, server_base):
    """Extrae tokens de cada canal y genera M3U8 con URLs proxy completas"""
    contenido = "#EXTM3U\n"
    ok = 0
    fail = 0

    for i, ch in enumerate(canales):
        print(f"  [{i+1}/{len(canales)}] {ch['name']}...", end=" ", flush=True)
        try:
            r = requests.post(
                f"{server_base}/api/extract",
                json={"name": ch['name'], "code": ch['code']},
                timeout=120
            )
            data = r.json()
            if data.get('success') and data.get('m3u8Url'):
                proxy_url = f"{server_base}/stream?url={data['m3u8Url']}"
                contenido += f'#EXTINF:-1 group-title="{ch["group"]}",{ch["name"]}\n'
                contenido += f'{proxy_url}\n'
                print(f"OK ({data.get('method','?')}, {data.get('elapsed','?')})")
                ok += 1
            else:
                print(f"FAIL: {data.get('error','unknown')}")
                fail += 1
        except Exception as e:
            print(f"ERROR: {e}")
            fail += 1

    print(f"\n  Resultado: {ok} OK, {fail} fallidos")
    return contenido if ok > 0 else None

def subir_a_github(contenido):
    """Sube el contenido M3U8 al Gist"""
    url = f"https://api.github.com/gists/{GIST_ID}"
    headers = {"Authorization": f"token {GITHUB_TOKEN}"}
    data = {"files": {"lista_iptv.m3u8": {"content": contenido}}}

    r = requests.patch(url, headers=headers, data=json.dumps(data))
    if r.status_code == 200:
        gist_data = r.json()
        raw_url = gist_data['files']['lista_iptv.m3u8']['raw_url']
        print(f"[{time.strftime('%H:%M:%S')}] Subida exitosa a GitHub!")
        print(f"  URL del Gist: {raw_url}")
        return True
    else:
        print(f"Error al subir: {r.status_code} - {r.text[:200]}")
        return False

def verificar_servidor(server_base):
    """Verifica que el servidor Node.js esté corriendo"""
    try:
        r = requests.get(f"{server_base}/api/channels", timeout=10)
        return r.status_code == 200
    except:
        return False

# --- PROGRAMA PRINCIPAL ---
if __name__ == "__main__":
    # Determinar servidor (cloud o local)
    if CLOUD_SERVER_URL:
        server_base = CLOUD_SERVER_URL.rstrip('/')
        print(f"="*50)
        print(f"  IPTV Actualizador (CLOUD)")
        print(f"  Servidor: {server_base}")
        print(f"="*50)
    else:
        server_ip = get_local_ip()
        server_base = f"http://{server_ip}:{SERVER_PORT}"
        print(f"="*50)
        print(f"  IPTV Actualizador (LOCAL)")
        print(f"  IP local: {server_ip}")
        print(f"  Servidor: {server_base}")
        print(f"="*50)

    # Verificar servidor
    if not verificar_servidor(server_base):
        print(f"\n[!] El servidor no responde en: {server_base}")
        if not CLOUD_SERVER_URL:
            print(f"    Ejecuta: cd bot && node server.js")
        else:
            print(f"    Verifica que el servicio en Render esté activo")
        input("\nPresiona Enter para salir...")
        exit(1)

    print(f"[OK] Servidor detectado\n")

    # Leer canales
    if not os.path.exists(ARCHIVO_CANALES):
        print(f"[!] No existe '{ARCHIVO_CANALES}'")
        print(f"    Crea el archivo con formato: nombre_canal,codigo_pais,grupo")
        exit(1)

    canales = leer_canales(ARCHIVO_CANALES)
    print(f"[OK] {len(canales)} canales cargados desde {ARCHIVO_CANALES}")

    # Extraer tokens y generar lista
    print(f"\nExtrayendo tokens (esto puede tardar ~{len(canales)*10}s)...\n")
    contenido = generar_m3u8(canales, server_base)

    if contenido:
        print(f"\n--- Lista M3U8 generada ---")
        print(contenido)
        print(f"--- Fin de la lista ---\n")
        subir_a_github(contenido)
    else:
        print("\n[!] No se pudo extraer ningún canal")

    # Bucle: refrescar tokens cada 3 horas + vigilar cambios en canales.txt
    REFRESH_INTERVAL = 3 * 60 * 60  # 3 horas en segundos
    ultima_modificacion = os.path.getmtime(ARCHIVO_CANALES)
    ultimo_refresh = time.time()

    print(f"\nModo automático activado:")
    print(f"  - Tokens se refrescan cada 3 horas")
    print(f"  - Si editas '{ARCHIVO_CANALES}', se regenera la lista\n")

    while True:
        try:
            # Comprobar cambios en canales.txt
            if os.path.exists(ARCHIVO_CANALES):
                tiempo_actual = os.path.getmtime(ARCHIVO_CANALES)
                if tiempo_actual > ultima_modificacion:
                    print(f"\n[{time.strftime('%H:%M:%S')}] Cambios en {ARCHIVO_CANALES} detectados")
                    canales = leer_canales(ARCHIVO_CANALES)
                    print(f"  {len(canales)} canales — extrayendo tokens...\n")
                    contenido = generar_m3u8(canales, server_base)
                    if contenido:
                        subir_a_github(contenido)
                    ultima_modificacion = tiempo_actual
                    ultimo_refresh = time.time()

            # Refrescar tokens periódicamente
            if time.time() - ultimo_refresh >= REFRESH_INTERVAL:
                print(f"\n[{time.strftime('%H:%M:%S')}] Refrescando tokens (cada 3h)...\n")
                canales = leer_canales(ARCHIVO_CANALES)
                contenido = generar_m3u8(canales, server_base)
                if contenido:
                    subir_a_github(contenido)
                ultimo_refresh = time.time()

            time.sleep(10)
        except KeyboardInterrupt:
            print("\nDetenido.")
            break