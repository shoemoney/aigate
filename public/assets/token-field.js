/** AIGate token field: WebGPU instanced atlas sprites, Canvas 2D fallback.
 * Ambient words are illustrative. Authenticated socket events add real bursts;
 * neither prompts nor credentials are ever painted into the background.
 */
const WORDS = ['TOKEN', 'CONTEXT', 'INPUT', 'OUTPUT', 'VECTOR', 'MODEL', 'EMBED', 'STREAM'];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const canvas = document.createElement('canvas');
canvas.className = 'token-field';
canvas.setAttribute('aria-hidden', 'true');
Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '0' });
document.body.prepend(canvas);
let surface = canvas, device, context, pipeline, group, uniforms, atlasTexture;
let ctx, frame = 0, disposed = false, phase = 12, previous = 0, boost = 0, pulseAt = 0;
let width = innerWidth, height = innerHeight, ratio = 1, backend = 'initializing';
let frames = 0, events = 0, pointerX = .5, pointerY = .5;
const state = { get backend() { return backend; }, get frames() { return frames; }, get events() { return events; }, get reducedMotion() { return motion.matches; }, pulse: () => { boost = Math.min(boost + .6, 2); pulseAt = phase; requestFrame(); } };
window.AIGateField = state;
function resize() {
  width = innerWidth; height = innerHeight; ratio = Math.min(devicePixelRatio || 1, 1.6);
  surface.width = Math.max(1, Math.round(width * ratio)); surface.height = Math.max(1, Math.round(height * ratio));
  requestFrame();
}
function requestFrame() { if (!frame && !disposed && !document.hidden && backend !== 'initializing') frame = requestAnimationFrame(draw); }
function traffic(event) {
  if (!['prompt', 'tokens', 'usage', 'access', 'board', 'accounts', 'keys'].includes(event.detail?.type)) return;
  events++; state.pulse();
}
function pointer(event) { pointerX = event.clientX / width; pointerY = event.clientY / height; }
function visibility() { previous = 0; if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else requestFrame(); }
function reduce() { previous = 0; requestFrame(); }
addEventListener('resize', resize);
addEventListener('pointermove', pointer, { passive: true });
addEventListener('aigate:traffic', traffic);
document.addEventListener('visibilitychange', visibility);
motion.addEventListener('change', reduce);

const shader = `
struct Globals { resolution: vec2f, time: f32, boost: f32, pointer: vec2f, pad: vec2f };
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec3f, @location(2) alpha: f32, @location(3) row: f32 };
fn hash(n:f32) -> f32 { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
@vertex fn vs(@builtin(vertex_index) vertex:u32, @builtin(instance_index) instance:u32) -> Vertex {
  let corners = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let i = f32(instance); let q = corners[vertex]; let seed = hash(i+3.0);
  let t = g.time*(0.028+seed*0.024) + hash(i+17.0);
  let progress = fract(t); let lane = hash(i+57.0);
  let x = progress*1.4-0.2;
  let y = lane*1.25-0.12 + sin(progress*5.3+lane*6.28)*0.1;
  let center = vec2f(x,y) + (g.pointer-0.5)*0.013*(seed+0.2);
  let scale = 0.95 + seed*0.4;
  let size = vec2f(92.0,24.0)*scale;
  let angle = cos(progress*5.3+lane*6.28)*0.14;
  let local = vec2f(q.x*size.x, q.y*size.y);
  let rotated = vec2f(local.x*cos(angle)-local.y*sin(angle),local.x*sin(angle)+local.y*cos(angle));
  let pixel = center*g.resolution + rotated;
  var o:Vertex; o.position=vec4f(pixel/g.resolution*vec2f(2,-2)+vec2f(-1,1),0,1);
  o.uv=q*0.5+0.5; o.row=f32(instance%8u);
  o.color=mix(vec3f(0.18,0.59,0.82),vec3f(0.35,0.95,0.79),seed);
  o.alpha=(0.08+seed*0.13+g.boost*0.10)*smoothstep(0.0,0.12,progress)*(1.0-smoothstep(0.86,1.0,progress));
  return o;
}
@fragment fn fs(v:Vertex) -> @location(0) vec4f {
  let glyph = textureSample(atlas,texSampler,vec2f(v.uv.x,(v.uv.y+v.row)/8.0)).a;
  let trail = exp(-abs(v.uv.y-0.79)*100.0)*pow(v.uv.x,2.0)*0.38;
  let dot = exp(-length((v.uv-vec2f(0.92,0.79))*vec2f(38,9))*3.0);
  let opacity = max(glyph,trail+dot)*v.alpha;
  return vec4f(v.color*opacity,opacity);
}`;

async function webgpu() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  if (!adapter) throw new Error('No GPU adapter');
  device = await adapter.requestDevice();
  if (disposed) { device.destroy(); return; }
  device.lost.then(() => { if (!disposed) fallback(); });
  device.addEventListener('uncapturederror', () => { if (!disposed) fallback(); });
  context = surface.getContext('webgpu');
  if (!context) throw new Error('No WebGPU canvas');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });
  const atlas = document.createElement('canvas'); atlas.width = 256; atlas.height = 512;
  const ink = atlas.getContext('2d'); ink.fillStyle = '#fff'; ink.font = '500 27px ui-monospace, monospace'; ink.textAlign = 'center'; ink.textBaseline = 'middle';
  WORDS.forEach((word, i) => ink.fillText(word, 128, i*64+29));
  atlasTexture = device.createTexture({ size: [256,512], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  device.queue.copyExternalImageToTexture({ source: atlas }, { texture: atlasTexture }, [256,512]);
  uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: shader });
  const info = await module.getCompilationInfo();
  if (info.messages.some(m => m.type === 'error')) throw new Error('Token shader compilation failed');
  pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] }, primitive: { topology: 'triangle-list' } });
  group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: atlasTexture.createView() }, { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }] });
  backend = 'webgpu'; surface.dataset.renderer = backend; resize();
}
function fallback() {
  if (backend === 'canvas2d' || disposed) return;
  // A canvas cannot change context type after acquiring WebGPU.
  const replacement = canvas.cloneNode(); surface.replaceWith(replacement); surface = replacement;
  try { context?.unconfigure(); uniforms?.destroy(); atlasTexture?.destroy(); device?.destroy(); } catch { /* already lost */ }
  ctx = surface.getContext('2d'); backend = ctx ? 'canvas2d' : 'static'; surface.dataset.renderer = backend; resize();
}
function hash(n) { const value = Math.sin(n*127.1+311.7)*43758.5453; return value-Math.floor(value); }
function fallbackDraw() {
  if (!ctx) return;
  ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,width,height);
  const count = width < 700 ? 26 : 65;
  for (let i=0;i<count;i++) {
    const seed=hash(i+3), progress=(phase*(.028+seed*.024)+hash(i+17))%1, lane=hash(i+57);
    const x=(progress*1.4-.2)*width, y=(lane*1.25-.12+Math.sin(progress*5.3+lane*6.28)*.1)*height;
    const alpha=(.08+seed*.13+boost*.10)*Math.min(1,progress/.12,(1-progress)/.14);
    ctx.save(); ctx.translate(x,y); ctx.rotate(Math.cos(progress*5.3+lane*6.28)*.14);
    ctx.globalAlpha=alpha; ctx.fillStyle=i%3?'#67efd6':'#5095ce'; ctx.font=`500 ${18+Math.floor(seed*5)}px ui-monospace, monospace`;
    ctx.textAlign='center'; ctx.fillText(WORDS[i%8],0,0);
    const gradient=ctx.createLinearGradient(-75,0,75,0); gradient.addColorStop(0,'transparent'); gradient.addColorStop(1,'#67efd6');
    ctx.fillStyle=gradient; ctx.fillRect(-75,9,150,1); ctx.fillStyle='#9bffef'; ctx.fillRect(72,7,3,3); ctx.restore();
  }
}
function draw(now) {
  frame=0; if (disposed || document.hidden) return;
  const delta = previous ? Math.min((now-previous)/1000,.05) : 0; previous=now;
  if (!motion.matches) { phase+=delta*(1+boost*.7); boost*=Math.exp(-delta*1.7); }
  if (backend === 'webgpu') {
    try {
      device.queue.writeBuffer(uniforms,0,new Float32Array([width,height,phase,motion.matches?0:boost,pointerX,pointerY,pulseAt,0]));
      const encoder=device.createCommandEncoder();
      const pass=encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: {r:0,g:0,b:0,a:0}, loadOp:'clear', storeOp:'store' }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.draw(6,width<700?34:90); pass.end(); device.queue.submit([encoder.finish()]);
    } catch { fallback(); }
  } else fallbackDraw();
  frames++;
  if (!motion.matches && backend !== 'static') requestFrame();
}
function destroy(event) {
  // Keep resources for bfcache, but suspend animation until the document returns.
  cancelAnimationFrame(frame); frame=0;
  if (event.persisted) return;
  disposed=true;
  removeEventListener('resize',resize); removeEventListener('pointermove',pointer); removeEventListener('aigate:traffic',traffic);
  document.removeEventListener('visibilitychange',visibility); motion.removeEventListener('change',reduce);
  try { context?.unconfigure(); uniforms?.destroy(); atlasTexture?.destroy(); device?.destroy(); } catch { /* device already lost */ }
}
addEventListener('pagehide',destroy);
addEventListener('pageshow',()=>{previous=0;requestFrame();});
webgpu().catch(fallback);
