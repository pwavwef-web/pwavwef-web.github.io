(function () {
  if (!('serviceWorker' in navigator)) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  let installPrompt = null;
  let installBtn = null;

  function ensureInstallButton() {
    if (installBtn) return installBtn;

    installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.id = 'courses-install-app-btn';
    installBtn.textContent = 'Install App';
    installBtn.style.position = 'fixed';
    installBtn.style.right = '16px';
    installBtn.style.bottom = '16px';
    installBtn.style.zIndex = '9999';
    installBtn.style.background = '#2563eb';
    installBtn.style.color = '#fff';
    installBtn.style.border = 'none';
    installBtn.style.borderRadius = '999px';
    installBtn.style.padding = '10px 16px';
    installBtn.style.fontSize = '13px';
    installBtn.style.fontWeight = '600';
    installBtn.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.35)';
    installBtn.style.cursor = 'pointer';
    installBtn.style.display = 'none';

    installBtn.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      try {
        await installPrompt.userChoice;
      } finally {
        installPrompt = null;
        installBtn.style.display = 'none';
      }
    });

    document.body.appendChild(installBtn);
    return installBtn;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    if (isStandalone) return;
    ensureInstallButton().style.display = 'inline-flex';
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    if (installBtn) installBtn.style.display = 'none';
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
})();
