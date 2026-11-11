# Update

From the module directory run:

```bash
cd ~/MagicMirror/modules/MMM-HomeConnect2
git pull
git submodule update --init --recursive
npm ci --omit=dev
```

Restart MagicMirror after the update so the backend and token handling code are reloaded.
