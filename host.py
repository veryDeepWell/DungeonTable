"""DungeonTable: local Node.js server + optional Cloudflare Tunnel and registry lease."""
import argparse
import getpass
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / 'data' / 'host.local.json'


def start_process(arguments, env=None):
    process = subprocess.Popen(arguments, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    lines = queue.Queue()
    recent = []

    def read():
        for line in process.stdout:
            recent.append(line.rstrip())
            if len(recent) > 30:
                recent.pop(0)
            lines.put(line)
    threading.Thread(target=read, daemon=True).start()
    return process, lines, recent


def wait_address(item, pattern, timeout):
    process, lines, recent = item
    end = time.monotonic() + timeout
    while time.monotonic() < end and process.poll() is None:
        try:
            line = lines.get(timeout=.2)
        except queue.Empty:
            continue
        match = re.search(pattern, line)
        if match:
            return match.group(0)
    raise RuntimeError('Процесс не сообщил адрес.\n' + '\n'.join(recent[-8:]))


def request_registry(registry, key, method, session, origin=None):
    payload = {'session': session}
    if origin:
        payload['origin'] = origin
    req = Request(registry + '/host', method=method, data=json.dumps(payload).encode(),
                  headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                           'User-Agent': 'DungeonTable-Host/0.2'})
    with urlopen(req, timeout=8) as response:
        if not json.load(response).get('ok'):
            raise RuntimeError('Реестр не подтвердил регистрацию.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', action='store_true', help='Только локальная проверка, без туннеля.')
    parser.add_argument('--setup', action='store_true', help='Повторно ввести параметры Cloudflare.')
    parser.add_argument('--port', type=int, default=8787)
    args = parser.parse_args()
    if not shutil.which('node'):
        parser.error('Нужен Node.js 22.13 или новее (с node:sqlite).')
    if not args.local and not shutil.which('cloudflared'):
        parser.error('Установите cloudflared или используйте --local.')
    config = {}
    processes = []
    session = secrets.token_hex(16)
    registered = False
    try:
        if not args.local:
            if CONFIG.exists() and not args.setup:
                config = json.loads(CONFIG.read_text(encoding='utf-8'))
            if not config:
                config = {'registry': input('Адрес Worker DungeonTable: ').strip().rstrip('/'),
                          'key': getpass.getpass('HOST_KEY реестра (ввод скрыт): ').strip(),
                          'site': input('Origin сайта [https://verydeepwell.github.io]: ').strip() or 'https://verydeepwell.github.io'}
            if not re.fullmatch(r'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev', config.get('registry', '')) or not config.get('key'):
                raise ValueError('Неверные параметры Worker / HOST_KEY.')
        env = {**os.environ, 'HOST': '127.0.0.1', 'PORT': str(args.port),
               'DT_ORIGIN': config.get('site', 'https://verydeepwell.github.io')}
        node = start_process(['node', 'server/main.mjs'], env)
        processes.append(node)
        local = wait_address(node, r'http://127\.0\.0\.1:\d+', 15)
        print('Локальный стол: ' + local, flush=True)
        print('Ключ создания комнат: data/admin-key.txt. Не передавайте его игрокам.', flush=True)
        if args.local:
            print('Работает локально. Ctrl+C — остановить.', flush=True)
        else:
            tunnel = start_process(['cloudflared', 'tunnel', '--url', local, '--no-autoupdate'])
            processes.append(tunnel)
            origin = wait_address(tunnel, r'https://[a-z0-9-]+\.trycloudflare\.com', 60)
            deadline = time.monotonic() + 45
            while True:
                try:
                    req = Request(origin + '/api/lobby/status', headers={'Origin': config['site']})
                    with urlopen(req, timeout=5) as response:
                        if json.load(response).get('service') == 'dungeon-table':
                            break
                except (OSError, ValueError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Игровой сервер не отвечает через Tunnel.')
                time.sleep(1)
            request_registry(config['registry'], config['key'], 'PUT', session, origin)
            registered = True
            CONFIG.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as out:
                json.dump(config, out)
            print('Сервер зарегистрирован: ' + origin, flush=True)
            print('Откройте GitHub Pages, создайте комнату и назначьте персонажей игрокам.', flush=True)
        next_renew = time.monotonic() + 12
        while all(item[0].poll() is None for item in processes):
            if not args.local and time.monotonic() >= next_renew:
                try:
                    request_registry(config['registry'], config['key'], 'PUT', session, origin)
                    next_renew = time.monotonic() + 12
                except HTTPError as error:
                    if error.code in (400, 401, 403, 409):
                        raise
                    print('Реестр временно недоступен; существующая игра продолжается.', flush=True)
                    next_renew = time.monotonic() + 5
                except OSError:
                    print('Реестр временно недоступен; существующая игра продолжается.', flush=True)
                    next_renew = time.monotonic() + 5
            time.sleep(.3)
        raise RuntimeError('Node.js или туннель остановился.\n' + '\n'.join(line for proc, _, recent in processes if proc.poll() is not None for line in recent[-6:]))
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print('Ошибка запуска: ' + str(error), file=sys.stderr)
        return 1
    finally:
        if registered:
            try:
                request_registry(config['registry'], config['key'], 'DELETE', session)
            except (OSError, ValueError, RuntimeError):
                pass
        for process, _, _ in reversed(processes):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    sys.exit(main())
