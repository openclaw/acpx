export function css() {
  return `
:root{
  --ink:#0b0e14;
  --text:#1f2530;
  --muted:#6a7282;
  --subtle:#9aa1ab;
  --bg:#f7f8fa;
  --paper:#ffffff;
  --accent:#0ea5e9;
  --accent-soft:rgba(14,165,233,.10);
  --accent-strong:#0284c7;
  --accent-2:#a855f7;
  --accent-3:#22c55e;
  --accent-4:#f59e0b;
  --line:#e5e7eb;
  --line-soft:#eef0f3;
  --code-bg:#0a0d14;
  --code-fg:#e6edf3;
  --code-inline-fg:#1c2128;
  --pill-border:#dbe2eb;
  --shadow-card:0 4px 14px rgba(15,17,21,.08);
  --scrollbar:#cbd5e1;
}
:root[data-theme="dark"]{
  --ink:#f3f5f9;
  --text:#cdd3dd;
  --muted:#8d96a4;
  --subtle:#5d6371;
  --bg:#08090f;
  --paper:#13161f;
  --accent:#38bdf8;
  --accent-soft:rgba(56,189,248,.18);
  --accent-strong:#7dd3fc;
  --line:#23283a;
  --line-soft:#1a1d28;
  --code-bg:#040611;
  --code-fg:#e6edf3;
  --code-inline-fg:#e6edf3;
  --pill-border:#2a2f3c;
  --shadow-card:0 4px 18px rgba(0,0,0,.45);
  --scrollbar:#3a4154;
}
:root{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:24px}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Inter",ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.65;overflow-x:hidden;-webkit-font-smoothing:antialiased;font-feature-settings:"cv02","cv03","cv04","cv11";transition:background-color .18s,color .18s}
::selection{background:var(--accent);color:#04121d}
a{color:var(--accent);text-decoration:none;transition:color .12s}
a:hover{text-decoration:underline;text-underline-offset:.2em}
.shell{display:grid;grid-template-columns:268px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 22px;background:var(--paper);border-right:1px solid var(--line);scrollbar-width:thin;scrollbar-color:var(--line) transparent;transition:background-color .18s,border-color .18s}
.sidebar::-webkit-scrollbar{width:6px}
.sidebar::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px}
.sidebar-head{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:11px;color:var(--ink);text-decoration:none;flex:1;min-width:0}
.brand:hover{text-decoration:none}
.brand .mark{flex:0 0 34px;width:34px;height:34px;border-radius:8px;background:linear-gradient(145deg,#08111f 0%,#101827 58%,#172554 100%);position:relative;overflow:hidden;display:grid;place-items:center;box-shadow:0 1px 0 rgba(255,255,255,.08) inset,0 10px 24px -13px rgba(14,165,233,.7)}
.brand .mark::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(125,211,252,.22),transparent 42%),linear-gradient(315deg,rgba(167,139,250,.2),transparent 48%);pointer-events:none}
.brand .mark::after{content:"";position:absolute;inset:1px;border-radius:7px;border:1px solid rgba(255,255,255,.1);pointer-events:none}
.brand .mark svg{position:relative;z-index:1;width:23px;height:23px;display:block}
.brand .mark .cursor{transform-origin:center;animation:acpx-blink 1.2s steps(2,jump-none) infinite}
@keyframes acpx-blink{0%,49%{opacity:1}50%,100%{opacity:.25}}
@media (prefers-reduced-motion: reduce){.brand .mark .cursor{animation:none}}
.brand strong{display:block;font-size:1.05rem;line-height:1.1;font-weight:600;letter-spacing:0;color:var(--ink)}
.brand small{display:block;color:var(--muted);font-size:.74rem;margin-top:3px;font-weight:400}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:var(--paper);color:var(--muted);cursor:pointer;padding:0;transition:border-color .15s,color .15s,background-color .15s,transform .12s}
.theme-toggle:hover{border-color:var(--ink);color:var(--ink)}
.theme-toggle:active{transform:scale(.94)}
.theme-toggle svg{width:16px;height:16px;display:block}
.theme-icon-sun{display:none}
:root[data-theme="dark"] .theme-icon-sun{display:block}
:root[data-theme="dark"] .theme-icon-moon{display:none}
.search{display:block;margin:0 0 22px}
.search span{display:block;color:var(--muted);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0;margin-bottom:7px}
.search input{width:100%;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:9px 12px;font:inherit;font-size:.9rem;color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s,background-color .18s}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
nav section{margin:0 0 18px}
nav h2{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0;margin:0 0 6px;font-weight:600}
.nav-link{display:block;color:var(--text);text-decoration:none;border-radius:6px;padding:5px 10px;margin:1px 0;font-size:.9rem;line-height:1.4;transition:background .12s,color .12s}
.nav-link:hover{background:var(--line-soft);color:var(--ink);text-decoration:none}
.nav-link.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
main{min-width:0;padding:32px clamp(20px,4.5vw,56px) 80px;max-width:1180px;margin:0 auto;width:100%}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;border-bottom:1px solid var(--line);padding:8px 0 22px;margin-bottom:8px;flex-wrap:wrap}
.hero-text{min-width:0;flex:1 1 320px}
.eyebrow{margin:0 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0;font-size:.7rem}
.hero h1{font-size:2.25rem;line-height:1.1;letter-spacing:-.01em;margin:0;font-weight:700;color:var(--ink)}
.hero-meta{display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap}
.repo,.edit,.btn-ghost{border:1px solid var(--line);color:var(--text);text-decoration:none;border-radius:7px;padding:6px 11px;font-weight:500;font-size:.83rem;background:var(--paper);transition:border-color .15s,color .15s,background .15s}
.repo:hover,.edit:hover,.btn-ghost:hover{border-color:var(--ink);color:var(--ink);text-decoration:none}
.edit{color:var(--muted)}
.home-hero{padding:14px 0 28px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.home-hero .eyebrow{display:inline-flex;align-items:center;gap:8px}
.home-hero .eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--accent-3);box-shadow:0 0 0 3px rgba(34,197,94,.2)}
.home-hero h1{font-size:3.25rem;line-height:1.04;letter-spacing:-.015em;margin:0 0 .35em;font-weight:700;color:var(--ink)}
.home-hero h1 .accent{background:linear-gradient(110deg,var(--accent) 0%,var(--accent-2) 70%);-webkit-background-clip:text;background-clip:text;color:transparent}
.home-hero .lede{font-size:1.18rem;line-height:1.55;color:var(--text);margin:0 0 1.2em;max-width:60ch}
.home-cta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 18px}
.home-cta .btn{display:inline-flex;align-items:center;gap:7px;border-radius:8px;padding:10px 16px;font-weight:600;font-size:.92rem;text-decoration:none;transition:background .15s,border-color .15s,color .15s,transform .12s}
.home-cta .btn-primary{background:var(--ink);color:var(--paper);border:1px solid var(--ink)}
.home-cta .btn-primary:hover{background:var(--accent);border-color:var(--accent);color:#04121d;text-decoration:none}
.home-cta .btn-ghost{padding:10px 16px}
.home-install{display:flex;align-items:center;gap:12px;background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:10px 10px 10px 16px;font:500 .9rem/1.2 "JetBrains Mono","SF Mono",ui-monospace,monospace;max-width:32em;border:1px solid #1f2937}
.home-install .prompt{color:#7dd3fc;user-select:none;flex:0 0 auto}
.home-install code{flex:1;background:transparent;border:0;color:var(--code-fg);font:inherit;padding:0;white-space:pre;overflow:hidden;text-overflow:ellipsis}
.home-install .copy{flex:0 0 auto;background:rgba(255,255,255,.08);color:var(--code-fg);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:5px 11px;font:500 .72rem/1 "Inter",sans-serif;cursor:pointer;transition:background .15s,border-color .15s}
.home-install .copy:hover{background:rgba(255,255,255,.16)}
.home-install .copy.copied{background:var(--accent);border-color:var(--accent);color:#04121d}
.home-services{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 18px}
.home-services span{display:inline-block;padding:3px 9px;border:1px solid var(--line);border-radius:999px;font-size:.78rem;color:var(--muted);background:var(--paper);font-family:"JetBrains Mono","SF Mono",ui-monospace,monospace}
.doc-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:48px;margin-top:24px}
.doc-grid-home{margin-top:8px}
@media(min-width:1180px){.doc-grid{grid-template-columns:minmax(0,72ch) 200px;justify-content:start}.doc-grid-home{grid-template-columns:minmax(0,76ch);justify-content:start}}
.doc{min-width:0;max-width:72ch;overflow-wrap:break-word}
.doc-home{max-width:76ch}
.doc h1{font-size:2.6rem;line-height:1.08;letter-spacing:-.015em;margin:0 0 .4em;font-weight:700;color:var(--ink)}
body:not(.home) .doc>h1:first-child{display:none}
.doc h2{font-size:1.45rem;line-height:1.2;margin:2em 0 .5em;font-weight:600;letter-spacing:-.005em;color:var(--ink);position:relative}
.doc h3{font-size:1.1rem;margin:1.7em 0 .35em;position:relative;font-weight:600;color:var(--ink);letter-spacing:0}
.doc h4{font-size:.98rem;margin:1.4em 0 .25em;color:var(--ink);position:relative;font-weight:600}
.doc h2:first-child,.doc h3:first-child,.doc h4:first-child{margin-top:.2em}
.doc :is(h2,h3,h4) .anchor{position:absolute;left:-1.05em;top:0;color:var(--subtle);opacity:0;text-decoration:none;font-weight:400;padding-right:.3em;transition:opacity .12s,color .12s}
.doc :is(h2,h3,h4):hover .anchor{opacity:.7}
.doc :is(h2,h3,h4) .anchor:hover{opacity:1;color:var(--accent);text-decoration:none}
.doc p{margin:0 0 1.05em}
.doc ul,.doc ol{padding-left:1.3rem;margin:0 0 1.15em}
.doc li{margin:.25em 0}
.doc li>p{margin:0 0 .4em}
.doc strong{font-weight:600;color:var(--ink)}
.doc em{font-style:italic}
.doc code{font-family:"JetBrains Mono","SF Mono",ui-monospace,monospace;font-size:.84em;background:var(--line-soft);border:1px solid var(--line);border-radius:5px;padding:.08em .35em;color:var(--code-inline-fg)}
.doc pre{position:relative;overflow:auto;background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:14px 18px;margin:1.3em 0;font-size:.85em;line-height:1.6;scrollbar-width:thin;scrollbar-color:#334155 transparent;border:1px solid #1f2937}
.doc pre::-webkit-scrollbar{height:8px;width:8px}
.doc pre::-webkit-scrollbar-thumb{background:#334155;border-radius:8px}
.doc pre code{display:block;background:transparent;border:0;color:inherit;padding:0;font-size:1em;white-space:pre}
.doc pre .hl-com{color:#7a8597;font-style:italic}
.doc pre .hl-str{color:#86efac}
.doc pre .hl-num{color:#fbbf24}
.doc pre .hl-kw{color:#c4b5fd;font-weight:500}
.doc pre .hl-lit{color:#f0abfc}
.doc pre .hl-flag{color:#7dd3fc}
.doc pre .hl-var{color:#fca5a5}
.doc pre .hl-prop{color:#7dd3fc}
.doc pre .hl-op{color:#94a3b8}
.doc pre .hl-typ{color:#fde68a}
.doc pre .copy{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.06);color:var(--code-fg);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:3px 9px;font:500 .7rem/1 "Inter",sans-serif;cursor:pointer;opacity:0;transition:opacity .15s,background .15s,border-color .15s}
.doc pre:hover .copy,.doc pre .copy:focus{opacity:1}
.doc pre .copy:hover{background:rgba(255,255,255,.12)}
.doc pre .copy.copied{background:var(--accent);border-color:var(--accent);color:#04121d;opacity:1}
.doc blockquote{margin:1.4em 0;padding:10px 16px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 8px 8px 0;color:var(--text)}
.doc blockquote p:last-child{margin-bottom:0}
.doc .table-scroll{overflow-x:auto;margin:1.2em 0}
.doc table{width:100%;border-collapse:collapse;margin:0;font-size:.92em}
.doc th,.doc td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}
.doc th{font-weight:600;color:var(--ink);background:var(--line-soft);border-bottom:1px solid var(--line)}
.doc hr{border:0;border-top:1px solid var(--line);margin:2.2em 0}
.toc{position:sticky;top:24px;align-self:start;font-size:.84rem;padding-left:14px;border-left:1px solid var(--line);max-height:calc(100vh - 48px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.toc::-webkit-scrollbar{width:5px}
.toc::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
.toc h2{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:0;margin:0 0 10px;font-weight:600}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:4px 0 4px 10px;line-height:1.35;border-left:2px solid transparent;margin-left:-12px;transition:color .12s,border-color .12s}
.toc a:hover{color:var(--ink);text-decoration:none}
.toc a.active{color:var(--accent);border-left-color:var(--accent);font-weight:500}
.toc-l3{padding-left:22px!important;font-size:.94em}
@media(max-width:1179px){.toc{display:none}}
.page-nav{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:48px;border-top:1px solid var(--line);padding-top:20px}
.page-nav>a{display:block;border:1px solid var(--line);background:var(--paper);border-radius:9px;padding:13px 16px;text-decoration:none;color:var(--text);transition:border-color .15s,transform .15s,box-shadow .15s,background-color .18s}
.page-nav>a:hover{border-color:var(--accent);text-decoration:none;color:var(--ink)}
.page-nav small{display:block;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:0;margin-bottom:5px;font-weight:600}
.page-nav span{display:block;font-weight:600;line-height:1.3;color:var(--ink)}
.page-nav-prev{text-align:left}
.page-nav-next{text-align:right;grid-column:2}
.page-nav-prev:only-child{grid-column:1}
.nav-toggle{display:none;position:fixed;top:14px;right:14px;top:calc(14px + env(safe-area-inset-top, 0px));right:calc(14px + env(safe-area-inset-right, 0px));z-index:20;width:40px;height:40px;border-radius:9px;background:var(--paper);border:1px solid var(--line);color:var(--ink);cursor:pointer;padding:10px 9px;flex-direction:column;align-items:stretch;justify-content:space-between;box-shadow:var(--shadow-card)}
.nav-toggle span{display:block;width:100%;height:2px;flex:0 0 2px;background:currentColor;border-radius:2px;transition:transform .2s,opacity .2s}
.nav-toggle[aria-expanded="true"] span:nth-child(1){transform:translateY(8px) rotate(45deg)}
.nav-toggle[aria-expanded="true"] span:nth-child(2){opacity:0}
.nav-toggle[aria-expanded="true"] span:nth-child(3){transform:translateY(-8px) rotate(-45deg)}
@media(max-width:900px){
  .shell{display:block}
  .sidebar{position:fixed;inset:0 30% 0 0;max-width:320px;height:100vh;z-index:15;transform:translateX(-100%);transition:transform .25s ease,background-color .18s,border-color .18s;box-shadow:0 18px 40px rgba(0,0,0,.18);background:var(--paper);pointer-events:none}
  .sidebar.open{transform:translateX(0);pointer-events:auto}
  .nav-toggle{display:flex}
  main{padding:64px 18px 56px}
  .hero{padding-top:6px}
  .hero h1{font-size:1.8rem}
  .home-hero h1{font-size:2.45rem}
  .doc h1{font-size:2.1rem}
  .hero-meta{width:100%;justify-content:flex-start}
  .home-hero{padding-top:8px}
  .doc{padding:0}
  .doc-grid{margin-top:18px;gap:24px}
  .doc :is(h2,h3,h4) .anchor{display:none}
}
@media(max-width:520px){
  main{padding:60px 14px 48px}
  .doc pre{margin-left:-14px;margin-right:-14px;border-radius:0;border-left:0;border-right:0}
  .home-install{flex-wrap:wrap}
}
`;
}

export function js() {
  return `
const themeRoot=document.documentElement;
function applyTheme(mode){themeRoot.dataset.theme=mode;document.querySelectorAll('[data-theme-toggle]').forEach(b=>b.setAttribute('aria-pressed',mode==='dark'?'true':'false'))}
function storedTheme(){try{return localStorage.getItem('theme')}catch(e){return null}}
function persistTheme(mode){try{localStorage.setItem('theme',mode)}catch(e){}}
applyTheme(themeRoot.dataset.theme==='dark'?'dark':'light');
document.querySelectorAll('[data-theme-toggle]').forEach(btn=>{btn.addEventListener('click',()=>{const next=themeRoot.dataset.theme==='dark'?'light':'dark';applyTheme(next);persistTheme(next)})});
const systemDark=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)');
function onSystemChange(e){if(storedTheme())return;applyTheme(e.matches?'dark':'light')}
if(systemDark){if(systemDark.addEventListener)systemDark.addEventListener('change',onSystemChange);else if(systemDark.addListener)systemDark.addListener(onSystemChange)}
const sidebar=document.querySelector('.sidebar');
const toggle=document.querySelector('.nav-toggle');
const mobileNav=window.matchMedia('(max-width: 900px)');
const sidebarFocusable='a[href],button,input,select,textarea,[tabindex]';
function setSidebarFocusable(enabled){
  sidebar?.querySelectorAll(sidebarFocusable).forEach((el)=>{
    if(enabled){
      if(el.dataset.sidebarTabindex!==undefined){
        if(el.dataset.sidebarTabindex)el.setAttribute('tabindex',el.dataset.sidebarTabindex);
        else el.removeAttribute('tabindex');
        delete el.dataset.sidebarTabindex;
      }
    }else if(el.dataset.sidebarTabindex===undefined){
      el.dataset.sidebarTabindex=el.getAttribute('tabindex')??'';
      el.setAttribute('tabindex','-1');
    }
  });
}
function setSidebarOpen(open){
  if(!sidebar||!toggle)return;
  sidebar.classList.toggle('open',open);
  toggle.setAttribute('aria-expanded',open?'true':'false');
  if(mobileNav.matches){
    sidebar.inert=!open;
    if(open)sidebar.removeAttribute('aria-hidden');
    else sidebar.setAttribute('aria-hidden','true');
    setSidebarFocusable(open);
  }else{
    sidebar.inert=false;
    sidebar.removeAttribute('aria-hidden');
    setSidebarFocusable(true);
  }
}
setSidebarOpen(false);
toggle?.addEventListener('click',()=>setSidebarOpen(!sidebar?.classList.contains('open')));
document.addEventListener('click',(e)=>{if(!sidebar?.classList.contains('open'))return;if(sidebar.contains(e.target)||toggle?.contains(e.target))return;setSidebarOpen(false)});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')setSidebarOpen(false)});
const syncSidebarForViewport=()=>setSidebarOpen(sidebar?.classList.contains('open')??false);
if(mobileNav.addEventListener)mobileNav.addEventListener('change',syncSidebarForViewport);
else mobileNav.addListener?.(syncSidebarForViewport);
const input=document.getElementById('doc-search');
input?.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();document.querySelectorAll('nav section').forEach(sec=>{let any=false;sec.querySelectorAll('.nav-link').forEach(a=>{const m=!q||a.textContent.toLowerCase().includes(q);a.style.display=m?'block':'none';if(m)any=true});sec.style.display=any?'block':'none'})});
function attachCopy(target,getText){const btn=document.createElement('button');btn.type='button';btn.className='copy';btn.textContent='Copy';btn.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(getText());btn.textContent='Copied';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1400)}catch{btn.textContent='Failed';setTimeout(()=>{btn.textContent='Copy'},1400)}});target.appendChild(btn)}
document.querySelectorAll('.doc pre').forEach(pre=>attachCopy(pre,()=>pre.querySelector('code')?.textContent??''));
document.querySelectorAll('.home-install').forEach(el=>attachCopy(el,()=>el.querySelector('code')?.textContent??''));
const tocLinks=document.querySelectorAll('.toc a');
if(tocLinks.length){const map=new Map();tocLinks.forEach(a=>{const id=a.getAttribute('href').slice(1);const el=document.getElementById(id);if(el)map.set(el,a)});const setActive=l=>{tocLinks.forEach(x=>x.classList.remove('active'));l.classList.add('active')};const obs=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);if(visible.length){const link=map.get(visible[0].target);if(link)setActive(link)}},{rootMargin:'-15% 0px -65% 0px',threshold:0});map.forEach((_,el)=>obs.observe(el))}
`;
}

export function preThemeScript() {
  return `(function(){var s;try{s=localStorage.getItem('theme')}catch(e){}var d=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=s||(d?'dark':'light')})();`;
}

export function themeToggleHtml() {
  return `<button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false" data-theme-toggle>
    <svg class="theme-icon-moon" viewBox="0 0 20 20" aria-hidden="true"><path d="M14.6 12.1A6.5 6.5 0 0 1 7.4 2.7a6.5 6.5 0 1 0 7.2 9.4z" fill="currentColor"/></svg>
    <svg class="theme-icon-sun" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="2" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18"/><line x1="2" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18" y2="10"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="14.4" y1="14.4" x2="15.8" y2="15.8"/><line x1="4.2" y1="15.8" x2="5.6" y2="14.4"/><line x1="14.4" y1="5.6" x2="15.8" y2="4.2"/></g></svg>
  </button>`;
}

export function brandMarkHtml() {
  return `<span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.8 6.8 10 12l-5.2 5.2" stroke="#7dd3fc" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 7.2h2.9c1.7 0 3.1 1.4 3.1 3.1v.5c0 1.7-1.4 3.1-3.1 3.1h-1.4c-1.7 0-3.1 1.4-3.1 3.1v.5" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round"/><circle cx="13.2" cy="7.2" r="1.6" fill="#7dd3fc"/><circle cx="19.2" cy="12" r="1.6" fill="#a78bfa"/><rect class="cursor" x="13.2" y="16.2" width="6.6" height="2.5" rx="1.25" fill="#e0e7ff"/></svg></span>`;
}

export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="acpx">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#08111f"/>
    <stop offset="0.58" stop-color="#101827"/>
    <stop offset="1" stop-color="#172554"/>
  </linearGradient>
  <linearGradient id="wash" x1="6" y1="5" x2="58" y2="59" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#7dd3fc" stop-opacity="0.26"/>
    <stop offset="1" stop-color="#a78bfa" stop-opacity="0.22"/>
  </linearGradient>
</defs>
<rect width="64" height="64" rx="14" fill="url(#bg)"/>
<rect width="64" height="64" rx="14" fill="url(#wash)"/>
<rect x="1.5" y="1.5" width="61" height="61" rx="12.5" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.12"/>
<path d="M14 18 28 32 14 46" fill="none" stroke="#7dd3fc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M35 20h6c4.4 0 8 3.6 8 8v1.2c0 4.4-3.6 8-8 8h-2.5c-4.4 0-8 3.6-8 8V46" fill="none" stroke="#a78bfa" stroke-width="4.5" stroke-linecap="round"/>
<circle cx="35" cy="20" r="4" fill="#7dd3fc"/>
<circle cx="49" cy="32" r="4" fill="#a78bfa"/>
<rect x="34" y="44" width="17" height="6" rx="3" fill="#e0e7ff"/>
</svg>`;
}
