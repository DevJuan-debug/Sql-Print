// Convierte el SVG autónomo de un diagrama en PNG.
const MAX_SIDE = 16000; // límite práctico de tamaño de un canvas en los navegadores

function svgSize(svg) {
  const w = Number(svg.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1]);
  const h = Number(svg.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1]);
  return { w: w || 800, h: h || 600 };
}

export async function svgToPng(svg, scale = 2) {
  const { w, h } = svgSize(svg);
  const s = Math.max(0.1, Math.min(scale, MAX_SIDE / w, MAX_SIDE / h));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('No se pudo generar la imagen'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * s);
    canvas.height = Math.ceil(h * s);
    const c = canvas.getContext('2d');
    c.scale(s, s);
    c.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
