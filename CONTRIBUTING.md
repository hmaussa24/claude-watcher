# Reglas para contribuir

## Ramas

- `master` — rama principal protegida. No se permite push directo.
- Toda modificacion debe hacerse en una rama separada y entrar por Pull Request.

## Flujo de trabajo

1. Crea una rama desde `master` con un nombre descriptivo:

```bash
git checkout -b feature/nombre-de-la-feature
git checkout -b fix/descripcion-del-bug
```

2. Haz tus cambios y commitea siguiendo el formato de commits (ver abajo).

3. Sube la rama y abre un Pull Request hacia `master`:

```bash
git push origin feature/nombre-de-la-feature
```

4. El PR debe ser revisado y aprobado antes de hacer merge.

## Formato de commits

Usa el siguiente prefijo segun el tipo de cambio:

| Prefijo | Cuando usarlo |
|---------|--------------|
| `feat:` | Nueva funcionalidad |
| `fix:` | Correccion de bug |
| `refactor:` | Cambio de codigo que no agrega ni corrige nada |
| `docs:` | Cambios en documentacion |
| `chore:` | Tareas de mantenimiento (dependencias, config) |

Ejemplos:

```
feat: agregar soporte para archivos .env
fix: corregir badge de archivos nuevos en el arbol
docs: actualizar README con nuevos atajos
```

## Pull Requests

- El titulo del PR debe describir claramente el cambio.
- Incluye una descripcion de que cambiaste y por que.
- Un PR debe resolver una sola cosa (no mezclar features con fixes).
- No se hace merge sin al menos una aprobacion.

## Desarrollo local

```bash
git clone https://github.com/hmaussa24/claude-watcher.git
cd claude-watcher
npm install
npm start
```

Para probar como comando global:

```bash
npm link
claude-watcher
```
