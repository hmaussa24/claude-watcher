# Claude Watcher

Terminal UI para monitorear cambios de archivos en tiempo real, diseñada para trabajar junto a Claude Code.

## Instalacion

Requiere Node.js >= 18.

```bash
npm install -g claude-watcher-tui
```

O desde el repositorio:

```bash
git clone https://github.com/hmaussa24/claude-watcher.git
cd claude-watcher
npm install
npm link
```

## Uso

```bash
claude-watcher                  # abre el selector de proyectos
claude-watcher /ruta/proyecto   # abre directamente una carpeta
```

## Atajos de teclado

### Panel arbol de archivos

| Tecla | Accion |
|-------|--------|
| `↑` `↓` / `j` `k` | Navegar |
| `Enter` | Abrir archivo / expandir directorio |
| `Tab` | Cambiar al panel de diff |
| `q` | Salir |

### Panel de diff

| Tecla | Accion |
|-------|--------|
| `↑` `↓` / `j` `k` | Scroll |
| `n` / `b` | Siguiente / anterior cambio |
| `←` `→` | Archivo mas nuevo / mas antiguo |
| `v` | Abrir vimdiff |
| `o` | Abrir en vim |
| `g` / `G` | Inicio / final del archivo |
| `Tab` | Volver al arbol |
| `q` | Salir |

## Estructura del proyecto

```
claude-watcher/
├── src/
│   ├── App.jsx       # Interfaz TUI (componentes React/Ink)
│   └── watcher.js    # Logica de observacion de archivos (chokidar)
├── index.js          # Punto de entrada
└── package.json
```

## Tecnologias

- [Ink](https://github.com/vadimdemedes/ink) — React para la terminal
- [Chokidar](https://github.com/paulmillr/chokidar) — Observacion de archivos
- [diff](https://github.com/kpdecker/jsdiff) — Calculo de diferencias
