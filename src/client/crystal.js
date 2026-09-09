// Animated WebGL crystal — low-poly icosahedron with dark core, purple shell, glowing edges.
// three.js is dynamically imported so it isn't shipped to mobile / low-end clients.

export async function initCrystal(canvas, box) {
  if (!canvas || !box) return () => {};
  const THREE = await import("three");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.25 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(3.8, 2.5, 5.2);
  camera.lookAt(0, 0, 0);

  const sizeToBox = () => {
    const w = Math.max(1, box.clientWidth);
    const h = Math.max(1, box.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  sizeToBox();

  const group = new THREE.Group();
  scene.add(group);

  const geometry = new THREE.IcosahedronGeometry(1.2, 0);
  const core = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x1a1030, metalness: 0.7, roughness: 0.35 }),
  );
  core.scale.setScalar(0.935);
  group.add(core);

  const shell = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: 0x9b6bff,
      transparent: true,
      opacity: 0.55,
      metalness: 0.18,
      roughness: 0.16,
    }),
  );
  group.add(shell);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xe4d8ff, transparent: true, opacity: 0.95 }),
  );
  group.add(edges);

  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x8b5cf6, 0.75);
  rimLight.position.set(-2, 1, -3);
  scene.add(rimLight);

  let raf = 0,
    running = true;
  const renderOnce = () => renderer.render(scene, camera);
  function animate() {
    if (!running) return;
    raf = requestAnimationFrame(animate);
    const t = performance.now() * 0.001;
    group.rotation.y += 0.0055;
    group.rotation.x = Math.sin(t * 0.5) * 0.09;
    group.position.y = Math.sin(t * 0.9) * 0.06;
    renderOnce();
  }
  if (reduceMotion) renderOnce();
  else animate();

  const ro = new ResizeObserver(() => {
    sizeToBox();
    renderOnce();
  });
  ro.observe(box);

  const onVis = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!reduceMotion && !running) {
      running = true;
      animate();
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    geometry.dispose();
    core.material.dispose();
    shell.material.dispose();
    edges.geometry.dispose();
    edges.material.dispose();
    renderer.dispose();
  };
}
