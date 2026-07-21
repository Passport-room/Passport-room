// Animated WebGL crystal — low-poly icosahedron with dark core, purple shell, glowing edges.
import * as THREE from "three";

export function initCrystal(canvas, box){
  if (!canvas || !box) return () => {};
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, alpha:true, powerPreference:"high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(3.8, 2.5, 5.2);
  camera.lookAt(0, 0, 0);

  const sizeToBox = () => {
    const w = Math.max(1, box.clientWidth);
    const h = Math.max(1, box.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
  };
  sizeToBox();

  const group = new THREE.Group();
  scene.add(group);

  const geometry = new THREE.IcosahedronGeometry(1.2, 0);
  const core = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color:0x101015, metalness:0.75, roughness:0.42 }));
  core.scale.setScalar(0.935);
  group.add(core);

  const shell = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color:0x7a58ff, transparent:true, opacity:0.42, metalness:0.18, roughness:0.16 }));
  group.add(shell);

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color:0xbda7ff, transparent:true, opacity:0.62 }));
  group.add(edges);

  scene.add(new THREE.AmbientLight(0xffffff, 0.78));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
  keyLight.position.set(3, 4, 5); scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x8b5cf6, 0.45);
  rimLight.position.set(-2, 1, -3); scene.add(rimLight);

  let raf = 0, running = true;
  const renderOnce = () => renderer.render(scene, camera);
  function animate(){
    if (!running) return;
    raf = requestAnimationFrame(animate);
    const t = performance.now()*0.001;
    group.rotation.y += 0.0055;
    group.rotation.x = Math.sin(t*0.5)*0.09;
    group.position.y = Math.sin(t*0.9)*0.06;
    renderOnce();
  }
  if (reduceMotion) renderOnce(); else animate();

  const ro = new ResizeObserver(() => { sizeToBox(); renderOnce(); });
  ro.observe(box);

  const onVis = () => {
    if (document.hidden){ running = false; cancelAnimationFrame(raf); }
    else if (!reduceMotion && !running){ running = true; animate(); }
  };
  document.addEventListener("visibilitychange", onVis);

  return () => {
    running = false; cancelAnimationFrame(raf); ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    geometry.dispose(); core.material.dispose(); shell.material.dispose();
    edges.geometry.dispose(); edges.material.dispose();
    renderer.dispose();
  };
}
