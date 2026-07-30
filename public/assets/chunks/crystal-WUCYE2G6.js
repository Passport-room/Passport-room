async function v(p, r) {
  if (!p || !r) return () => {};
  let e = await import("three"),
    u = window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    n = new e.WebGLRenderer({
      canvas: p,
      antialias: !1,
      alpha: !0,
      powerPreference: "high-performance",
    });
  (n.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)),
    (n.outputColorSpace = e.SRGBColorSpace));
  let i = new e.Scene(),
    o = new e.PerspectiveCamera(45, 1, 0.1, 100);
  (o.position.set(3.8, 2.5, 5.2), o.lookAt(0, 0, 0));
  let w = () => {
    let s = Math.max(1, r.clientWidth),
      S = Math.max(1, r.clientHeight);
    (n.setSize(s, S, !1), (o.aspect = s / S), o.updateProjectionMatrix());
  };
  w();
  let t = new e.Group();
  i.add(t);
  let c = new e.IcosahedronGeometry(1.2, 0),
    d = new e.Mesh(
      c,
      new e.MeshStandardMaterial({
        color: 1052693,
        metalness: 0.75,
        roughness: 0.42,
      }),
    );
  (d.scale.setScalar(0.935), t.add(d));
  let g = new e.Mesh(
    c,
    new e.MeshStandardMaterial({
      color: 8018175,
      transparent: !0,
      opacity: 0.42,
      metalness: 0.18,
      roughness: 0.16,
    }),
  );
  t.add(g);
  let l = new e.LineSegments(
    new e.EdgesGeometry(c),
    new e.LineBasicMaterial({
      color: 12429311,
      transparent: !0,
      opacity: 0.62,
    }),
  );
  (t.add(l), i.add(new e.AmbientLight(16777215, 0.78)));
  let M = new e.DirectionalLight(16777215, 1.25);
  (M.position.set(3, 4, 5), i.add(M));
  let y = new e.DirectionalLight(9133302, 0.45);
  (y.position.set(-2, 1, -3), i.add(y));
  let m = 0,
    a = !0,
    f = () => n.render(i, o);
  function h() {
    if (!a) return;
    m = requestAnimationFrame(h);
    let s = performance.now() * 0.001;
    ((t.rotation.y += 0.0055),
      (t.rotation.x = Math.sin(s * 0.5) * 0.09),
      (t.position.y = Math.sin(s * 0.9) * 0.06),
      f());
  }
  u ? f() : h();
  let x = new ResizeObserver(() => {
    (w(), f());
  });
  x.observe(r);
  let L = () => {
    document.hidden
      ? ((a = !1), cancelAnimationFrame(m))
      : !u && !a && ((a = !0), h());
  };
  return (
    document.addEventListener("visibilitychange", L),
    () => {
      ((a = !1),
        cancelAnimationFrame(m),
        x.disconnect(),
        document.removeEventListener("visibilitychange", L),
        c.dispose(),
        d.material.dispose(),
        g.material.dispose(),
        l.geometry.dispose(),
        l.material.dispose(),
        n.dispose());
    }
  );
}
export { v as initCrystal };
