(function () {
  const ADS = {
    desktop728x90: {
      key: '3f0f6888dae71d934d2e0fb154fbb672',
      width: 728,
      height: 90
    },
    mobile320x50: {
      key: '055388b5882d41353186a8b64222a6af',
      width: 320,
      height: 50
    },
    mobile300x250: {
      key: 'bdcd23aa1b3c0d5279bdf128ff3ab6bb',
      width: 300,
      height: 250
    },
    native: {
      src: 'https://pl29902612.effectivecpmnetwork.com/f3e5d540eb0f2c4d69aaf118f83d22b8/invoke.js',
      containerId: 'container-f3e5d540eb0f2c4d69aaf118f83d22b8'
    }
  };

  const queue = [];
  let running = false;

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function createAdLabel() {
    const label = document.createElement('div');
    label.className = 'adsterra-label';
    label.textContent = 'Publicidade';
    return label;
  }

  function runQueue() {
    if (running || queue.length === 0) return;
    running = true;

    const task = queue.shift();
    task(() => {
      running = false;
      window.setTimeout(runQueue, 350);
    });
  }

  function enqueue(task) {
    queue.push(task);
    runQueue();
  }

  function loadIframeAd(slot, config) {
    if (!slot || slot.dataset.adLoaded === 'true') return;

    slot.dataset.adLoaded = 'true';
    slot.innerHTML = '';
    slot.appendChild(createAdLabel());

    const inner = document.createElement('div');
    inner.className = 'adsterra-inner';
    inner.style.width = config.width + 'px';
    inner.style.minHeight = config.height + 'px';
    slot.appendChild(inner);

    enqueue((done) => {
      window.atOptions = {
        key: config.key,
        format: 'iframe',
        height: config.height,
        width: config.width,
        params: {}
      };

      const invokeScript = document.createElement('script');
      invokeScript.type = 'text/javascript';
      invokeScript.async = false;
      invokeScript.src = 'https://www.highperformanceformat.com/' + config.key + '/invoke.js';
      invokeScript.onload = done;
      invokeScript.onerror = done;

      inner.appendChild(invokeScript);
      window.setTimeout(done, 2500);
    });
  }

  function loadResponsiveBanner(slotId, options = {}) {
    const slot = document.getElementById(slotId);
    if (!slot) return;

    const mobileType = options.mobileType || 'mobile320x50';
    const config = isMobile() ? ADS[mobileType] : ADS.desktop728x90;
    loadIframeAd(slot, config);
  }

  function loadMobileBox(slotId) {
    const slot = document.getElementById(slotId);
    if (!slot) return;

    const config = isMobile() ? ADS.mobile300x250 : ADS.desktop728x90;
    loadIframeAd(slot, config);
  }

  function loadNative(slotId) {
    const slot = document.getElementById(slotId);
    if (!slot || slot.dataset.adLoaded === 'true') return;

    slot.dataset.adLoaded = 'true';
    slot.innerHTML = '';
    slot.appendChild(createAdLabel());

    const uniqueId = ADS.native.containerId + '-' + slotId;
    const container = document.createElement('div');
    container.id = uniqueId;
    container.className = 'adsterra-native-container';

    const script = document.createElement('script');
    script.async = true;
    script.dataset.cfasync = 'false';
    script.src = ADS.native.src;

    // O Adsterra Native usa um container específico. Para evitar conflito, usamos apenas 1 native por página.
    container.id = ADS.native.containerId;
    slot.appendChild(container);
    slot.appendChild(script);
  }

  window.ZapAds = {
    loadResponsiveBanner,
    loadMobileBox,
    loadNative
  };
})();
