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
CLOUD_SERVER_URL = ""

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
    """Genera M3U8 con URLs apuntando al servidor (local o cloud)"""
    contenido = "#EXTM3U\n"
    for ch in canales:
        encoded_name = requests.utils.quote(ch['name'])
        url = f"{server_base}/play/{ch['code']}/{encoded_name}"
        contenido += f'#EXTINF:-1 group-title="{ch["group"]}",{ch["name"]}\n'
        contenido += f'{url}\n'
    return contenido

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

    # Generar y subir
    contenido = generar_m3u8(canales, server_base)
    print(f"\n--- Lista M3U8 generada ---")
    print(contenido)
    print(f"--- Fin de la lista ---\n")

    subir_a_github(contenido)

    # Modo vigilancia
    print(f"\nVigilando cambios en '{ARCHIVO_CANALES}'...")
    print(f"(Modifica el archivo para actualizar la lista automáticamente)\n")

    ultima_modificacion = os.path.getmtime(ARCHIVO_CANALES)

    while True:
        try:
            if os.path.exists(ARCHIVO_CANALES):
                tiempo_actual = os.path.getmtime(ARCHIVO_CANALES)
                if tiempo_actual > ultima_modificacion:
                    print(f"\n[{time.strftime('%H:%M:%S')}] Cambios detectados en {ARCHIVO_CANALES}")
                    canales = leer_canales(ARCHIVO_CANALES)
                    print(f"  {len(canales)} canales")
                    contenido = generar_m3u8(canales, server_base)
                    subir_a_github(contenido)
                    ultima_modificacion = tiempo_actual
            time.sleep(3)
        except KeyboardInterrupt:
            print("\nDetenido.")
            break