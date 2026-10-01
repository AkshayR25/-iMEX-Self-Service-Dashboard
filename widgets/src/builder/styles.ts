/**
 * Stylesheet for the full-screen Dashboard Builder and the shared UI pieces it uses (modals,
 * toasts, banners, form fields, rule / style / theme / rich-text editors, template gallery,
 * palette, chat panel).
 *
 * How it is loaded: `BUILDER_CSS` is a plain string. It is injected into `document.head` ONCE
 * per page via `ensureCss('dbb-css-builder', BUILDER_CSS)` (`render/theme.ts`), which skips the
 * insert if a `<style id="dbb-css-builder">` already exists. Both `builder/builder.ts` (when the
 * builder opens) and `entries/renderer.ts` (for the machine page's edit-menu dialogs) call it.
 * Each ThingsBoard widget type embeds its own copy of the library, so whichever loads first wins;
 * after changing this CSS, reload the page (not just the widget) to see the new version.
 *
 * Class-naming convention:
 * - Every block class is prefixed `dbb-` ("dashboard builder") so nothing collides with
 *   ThingsBoard / Angular Material styles, e.g. `.dbb-overlay`, `.dbb-field`, `.dbb-rule`.
 * - Parts of a block use a short suffix: `.dbb-modal-h` / `-b` / `-f` (header / body / footer),
 *   `.dbb-rte-bar`, `.dbb-rte-ed`.
 * - State and size modifiers are short unprefixed classes that only appear combined with a
 *   `dbb-` class: `.on`, `.sel`, `.sm`, `.half`, `.grow`, `.warn`, `.err`, `.primary`, `.danger`.
 * - Colours come from CSS variables (`--accent`, `--line`, `--ink`, `--ink-2`, `--ink-3`,
 *   `--surface`, `--plane`, `--danger`...) defined on `.dbb-root` in `render/theme.ts` and
 *   overridden per dashboard theme by `applyTheme`. Prefer the variables over hard-coded colours.
 * Grid-specific rules live next to the grid code (`GRID_CSS` in `render/grid.ts`); base card and
 * page styles are `CSS` in `render/theme.ts`.
 */
export const BUILDER_CSS = `
.dbb-overlay{position:fixed;inset:0;z-index:10000;background:#f4f5f7;display:flex;flex-direction:column;font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.dbb-overlay .dbb-center{font-family:var(--font)}
.dbb-top{display:flex;align-items:flex-end;gap:10px;padding:10px 14px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap;box-shadow:0 1px 3px rgba(16,24,40,.05);position:relative;z-index:3}
.dbb-brand{font-size:15px;font-weight:600;align-self:center;margin-right:6px;white-space:nowrap;display:flex;align-items:center;gap:8px;letter-spacing:-.01em}
.dbb-logo{width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#3987e5,#184f95);box-shadow:0 2px 6px rgba(42,120,214,.35)}
.dbb-logo svg{width:18px;height:18px}
.dbb-vsep{width:1px;height:24px;background:var(--line);margin:0 2px}
.dbb-field{display:flex;flex-direction:column;gap:4px;font-size:12px;min-width:0}
.dbb-field>span{color:var(--ink-3);font-size:11px;font-weight:500}
.dbb-field.grow{flex:1;min-width:160px}
.dbb-field.half{flex:1}
.dbb-field input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=file]),.dbb-field select,.dbb-field textarea,.dbb-sub select,.dbb-rule input,.dbb-rule select,.dbb-test input,.dbb-rte-link input,.dbb-pal-search input{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);min-width:0;transition:border-color .12s,box-shadow .12s}
.dbb-field input:focus,.dbb-field select:focus,.dbb-rule input:focus,.dbb-rule select:focus,.dbb-pal-search input:focus,.dbb-test input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.dbb-field input[type=range]{accent-color:var(--accent)}
.dbb-field input[type=file]{font-size:12px}
.dbb-field textarea{resize:vertical}
.dbb-tools{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
.dbb-btn.icon{padding:6px 8px;font-size:15px;line-height:1}
.dbb-btn.icon svg{width:16px;height:16px}
.dbb-btn.sm{padding:4px 9px;font-size:12px}
.dbb-btn.on{background:color-mix(in srgb,var(--accent) 10%,#fff);border-color:var(--accent);color:var(--accent)}
.dbb-btn.danger-fill{background:var(--danger);border-color:var(--danger)}
.dbb-banner-row{display:flex;flex-direction:column;gap:4px;padding:8px 14px 0}
.dbb-banner-row[hidden]{display:none}
.dbb-main{flex:1;display:flex;min-height:0}
.dbb-left{width:220px;background:#fff;border-right:1px solid var(--line);padding:12px;overflow:auto;flex:none}
.dbb-right{width:350px;background:#fff;border-left:1px solid var(--line);display:flex;flex-direction:column;flex:none;min-height:0}
.dbb-left[hidden],.dbb-right[hidden]{display:none}
.dbb-center{flex:1;overflow:auto;position:relative;min-width:0;background-color:var(--plane);transition:background-color .2s}
.dbb-canvas{margin:6px;min-height:400px;background-image:linear-gradient(to right,color-mix(in srgb,var(--ink) 5%,transparent) 1px,transparent 1px);background-size:calc((100% - 10px)/12) 100%;background-position:5px 0;border-radius:10px}
.dbb-canvas.preview{background-image:none}
.dbb-canvas.preview .dbb-gdrag,.dbb-canvas.preview .dbb-gresize,.dbb-canvas.preview .dbb-gtools{display:none}
.dbb-sec{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin:14px 0 6px}
.dbb-sec:first-child{margin-top:0}
.dbb-pal-search{position:sticky;top:-12px;background:#fff;padding:0 0 4px;z-index:1}
.dbb-pal-search input{width:100%;padding-left:30px;background:#f6f7f9 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23898781' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-4-4'/%3E%3C/svg%3E") no-repeat 9px center/14px}
.dbb-palette{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dbb-pal{display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 4px 8px;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:grab;font:inherit;font-size:11.5px;color:var(--ink-2);text-align:center;line-height:1.2;transition:border-color .12s,background .12s,transform .12s,box-shadow .12s}
.dbb-pal:hover{border-color:var(--accent);background:#f5f9fe;color:var(--ink);transform:translateY(-1px);box-shadow:0 3px 8px rgba(42,120,214,.12)}
.dbb-pal:active{cursor:grabbing}
.dbb-pal svg{width:22px;height:22px;flex:none;color:var(--accent)}
.dbb-hint{font-size:12px;color:var(--ink-3);margin:4px 0;line-height:1.45}
.dbb-hint code,.dbb-tip-row code{font-size:11px;background:#f1f0ec;padding:0 4px;border-radius:4px}
.dbb-muted{color:var(--ink-3);font-size:11px}
.dbb-count{font-size:11px;color:var(--ink-3);margin-top:14px;text-align:center}
.dbb-count.full{color:#b3541e;font-weight:600}
.dbb-pal.off{opacity:.42;cursor:not-allowed;filter:grayscale(1)}
.dbb-pal.off:hover{transform:none;box-shadow:none;border-color:var(--line);background:#fff}
.dbb-check.off{opacity:.45;cursor:not-allowed}
.dbb-na{font-size:10.5px;font-weight:600;color:var(--ink-3);background:#eceae4;border-radius:999px;padding:1px 7px;margin-left:2px;white-space:nowrap}
.dbb-range{display:flex;align-items:center;gap:6px}
.dbb-range select{padding:5px 8px}
.dbb-live{display:inline-block;width:7px;height:7px;border-radius:50%;background:#0ca30c;margin-right:6px;box-shadow:0 0 0 3px rgba(12,163,12,.18);vertical-align:1px}
.dbb-sel-h{display:flex;align-items:center;gap:10px;padding:12px 14px 4px}
.dbb-sel-h .ic{width:34px;height:34px;border-radius:10px;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;flex:none}
.dbb-sel-h .ic svg{width:20px;height:20px}
.dbb-sel-h>div{flex:1;min-width:0}
.dbb-sel-h .t{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-sel-h .s{font-size:11px;color:var(--ink-3)}
.dbb-tabs{display:flex;gap:4px;margin:8px 12px 0;padding:3px;background:#f1f2f4;border-radius:10px;flex:none}
.dbb-tab{flex:1;border:0;background:none;padding:7px 6px;font:inherit;font-size:12.5px;color:var(--ink-2);cursor:pointer;border-radius:8px;transition:background .12s,color .12s}
.dbb-tab:hover{color:var(--ink)}
.dbb-tab.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.dbb-panel{flex:1;overflow:auto;padding:12px 14px 20px;min-height:0;display:flex;flex-direction:column}
.dbb-form{display:flex;flex-direction:column;gap:9px}
.dbb-row{display:flex;gap:8px;align-items:flex-end}
.dbb-row.wrap{flex-wrap:wrap}
.dbb-check{display:flex;align-items:flex-start;gap:7px;font-size:13px;cursor:pointer;line-height:1.35}
.dbb-check input{margin-top:2px;accent-color:var(--accent)}
.dbb-check.dis{opacity:.55;cursor:default}
.dbb-src{display:flex;flex-direction:column;gap:6px}
.dbb-sub{margin-left:22px;display:flex;flex-direction:column;gap:6px;font-size:12px}
.dbb-sub[hidden]{display:none}
.dbb-keys{display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto;padding:8px;border:1px solid var(--grid);border-radius:8px;background:#fbfbfa}
.dbb-tip-row{font-size:12px;color:var(--ink-3);background:#f6f7f9;border-radius:8px;padding:8px 10px;line-height:1.45}
.dbb-tip-row a{color:var(--accent);font-weight:500}
.dbb-seg{display:inline-flex;padding:3px;background:#f1f2f4;border-radius:9px;gap:2px;flex-wrap:wrap}
.dbb-seg button{border:0;background:none;font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;color:var(--ink-2);cursor:pointer;white-space:nowrap}
.dbb-seg button.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.14)}
.dbb-seg.sm button{padding:4px 9px;font-size:11.5px}
.dbb-swatch{position:relative;display:inline-block;width:30px;height:30px;border-radius:8px;border:1px solid rgba(0,0,0,.12);cursor:pointer;flex:none;box-shadow:inset 0 0 0 2px rgba(255,255,255,.6)}
.dbb-swatch.empty{background:repeating-conic-gradient(#e6e5e0 0 25%,#fff 0 50%) 0 0/10px 10px}
.dbb-swatch input,.dbb-swatch input[type=color]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;border:0;padding:0}
.dbb-colf{display:inline-flex;align-items:center;gap:6px}
.dbb-x{border:0;background:none;color:var(--ink-3);cursor:pointer;font-size:12px;padding:4px;border-radius:6px;line-height:1}
.dbb-x:hover{background:#f1f0ec;color:var(--danger)}
.dbb-icons{display:grid;grid-template-columns:repeat(8,1fr);gap:4px}
.dbb-icons button{aspect-ratio:1;border:1px solid var(--line);background:#fff;border-radius:7px;color:var(--ink-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:13px}
.dbb-icons button svg{width:17px;height:17px}
.dbb-icons button:hover{border-color:var(--accent);color:var(--accent)}
.dbb-icons button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.dbb-presets{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.dbb-presets button{border:2px solid transparent;background:none;padding:0;border-radius:10px;cursor:pointer;font:inherit;font-size:11px;color:var(--ink-2);display:flex;flex-direction:column;gap:4px;align-items:stretch}
.dbb-presets button.on{color:var(--ink);font-weight:600}
.dbb-presets .pv{height:44px;border-radius:9px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:6px;border:1px solid var(--line)}
.dbb-presets button.on .pv{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 35%,transparent)}
.dbb-presets .pv i{border-radius:4px;border:1px solid;position:relative}
.dbb-presets .pv b{position:absolute;left:3px;right:3px;bottom:3px;height:4px;border-radius:2px}
.dbb-rules{display:flex;flex-direction:column;gap:10px}
.dbb-rule-list{display:flex;flex-direction:column;gap:8px}
.dbb-rule{border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;background:#fbfbfa}
.dbb-rule-main{display:flex;gap:6px;align-items:center}
.dbb-rule-main select{flex:none;max-width:110px}
.dbb-rule-main input:not([type=color]){flex:1;width:60px}
.dbb-rule-sub{display:flex;gap:6px;align-items:center}
.dbb-rule-sub input{flex:1;font-size:12px!important;padding:5px 8px!important}
.dbb-sw-row{display:flex;gap:3px}
.dbb-sw-row button{width:14px;height:14px;border-radius:4px;border:1px solid rgba(0,0,0,.12);cursor:pointer;padding:0}
.dbb-test{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3);border-top:1px dashed var(--line);padding-top:10px}
.dbb-test input{width:110px}
.dbb-test-out{display:inline-flex;align-items:center;gap:5px;color:var(--ink);font-weight:500}
.dbb-rte{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
.dbb-rte:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.dbb-rte-bar{display:flex;flex-wrap:wrap;gap:3px;padding:5px;background:#f6f7f9;border-bottom:1px solid var(--line);align-items:center}
.dbb-rte-bar button{width:28px;height:28px;border:0;background:none;border-radius:6px;cursor:pointer;color:var(--ink-2);display:inline-flex;align-items:center;justify-content:center;padding:0}
.dbb-rte-bar button:hover{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.dbb-rte-bar button svg{width:16px;height:16px}
.dbb-rte-bar select{font:inherit;font-size:11.5px;padding:4px 4px;border:1px solid var(--line);border-radius:6px;background:#fff;max-width:96px;height:28px}
.dbb-rte-bar .sep{width:1px;height:18px;background:var(--line);margin:0 2px}
.dbb-rte-col{position:relative;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px}
.dbb-rte-col:hover{background:#fff}
.dbb-rte-col input{position:absolute;inset:0;opacity:0;cursor:pointer}
.dbb-rte-link{display:flex;gap:6px;padding:6px;border-bottom:1px solid var(--line);background:#fffbe8}
.dbb-rte-link[hidden]{display:none}
.dbb-rte-link input{flex:1}
.dbb-rte-ed{padding:10px 12px;outline:none;font-size:13px;max-height:340px;overflow:auto;height:auto!important}
.dbb-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;padding:20px}
.dbb-empty[hidden]{display:none}
.dbb-empty-card{pointer-events:auto;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:16px;padding:26px 28px;max-width:680px;text-align:center;box-shadow:0 10px 30px rgba(16,24,40,.08)}
.dbb-empty-t{font-size:18px;font-weight:600;margin-bottom:6px;letter-spacing:-.01em}
.dbb-empty-s{font-size:13px;color:var(--ink-2);margin:6px 0}
.dbb-empty-a{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap}
.dbb-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-top:10px}
.dbb-tpl-grid.mini{grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px;text-align:left}
.dbb-tpl{border:1px solid var(--line);background:#fff;border-radius:12px;padding:8px;cursor:pointer;font:inherit;text-align:left;display:flex;flex-direction:column;gap:4px;transition:border-color .12s,transform .12s,box-shadow .12s;color:#0b0b0b}
.dbb-tpl:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 20px rgba(16,24,40,.1)}
.dbb-tpl .pv{height:74px;border-radius:8px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:1fr 1fr;gap:5px;padding:7px;margin-bottom:4px}
.dbb-tpl .pv i{border-radius:5px;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dbb-tpl .pv b{position:absolute;left:5px;bottom:5px;height:5px;width:45%;border-radius:3px}
.dbb-tpl .nm{font-weight:600;font-size:13px}
.dbb-tpl .ds{font-size:11px;color:#6e6d68;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dbb-tpl-grid.mini .dbb-tpl .ds{display:none}
.dbb-tpl-grid.mini .dbb-tpl .pv{height:54px}
.dbb-busy{position:absolute;right:16px;bottom:16px;background:#1a1a19;color:#fff;border-radius:10px;padding:9px 13px;display:flex;gap:8px;align-items:center;font-size:12px;z-index:20;box-shadow:0 6px 18px rgba(0,0,0,.2)}
.dbb-busy[hidden]{display:none}
.dbb-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:dbbspin .8s linear infinite}
@keyframes dbbspin{to{transform:rotate(360deg)}}
.dbb-chat{display:flex;flex-direction:column;height:100%;gap:8px;min-height:0}
.dbb-chat-log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:120px}
.dbb-msg{padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.45;max-width:92%}
.dbb-msg.user{background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.dbb-msg.assistant{background:#f1f2f4;align-self:flex-start;border-bottom-left-radius:4px}
.dbb-msg.system{background:none;color:var(--ink-3);font-size:12px;align-self:center;padding:2px}
.dbb-msg-sum{font-size:11px;color:var(--ink-2);margin-top:4px}
.dbb-msg-sum a{color:var(--accent)}
.dbb-opts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dbb-chat-bar{display:flex;gap:6px;flex-wrap:wrap}
.dbb-chat-form{display:flex;gap:6px;align-items:flex-end}
.dbb-chat-form textarea{flex:1;font:inherit;padding:9px;border:1px solid var(--line);border-radius:12px;resize:none}
.dbb-typing{color:var(--ink-3)}
.dbb-modal{position:absolute;inset:0;background:rgba(10,14,20,.42);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:30}
.dbb-modal-box{background:#fff;border-radius:14px;min-width:360px;max-width:min(820px,94vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:dbbfade .18s ease-out}
.dbb-modal-h{font-size:16px;font-weight:600;padding:16px 18px 6px}
.dbb-modal-b{padding:6px 18px;overflow:auto;font-size:13px;line-height:1.45}
.dbb-modal-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px 16px}
.dbb-preview{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dbb-nd{min-width:min(480px,86vw);display:flex;flex-direction:column;gap:12px}
.dbb-nd .dbb-field input{width:100%}
.dbb-nd-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e6e8ec;border-radius:10px;margin-top:6px;cursor:pointer}
.dbb-nd-opt:has(input:checked){border-color:#2a78d6;background:#f3f8fe}
.dbb-nd-opt input{margin-top:3px}
.dbb-nd-opt span{display:flex;flex-direction:column;gap:3px;font-size:13px}
.dbb-nd-opt small{color:#6b7380;font-size:12px}
.dbb-nd-opt select{margin-top:4px;max-width:260px}
.dbb-recent{margin-top:14px;text-align:left;display:flex;flex-direction:column;gap:4px}
.dbb-recent-h{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6b7380;margin-bottom:2px}
.dbb-recent-r{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:8px 12px;border:1px solid #e6e8ec;border-radius:8px;cursor:pointer;font-size:13px}
.dbb-recent-r:hover,.dbb-recent-r:focus-visible{background:#f3f8fe;border-color:#b9d3f3}
.dbb-recent-r span{color:#6b7380;font-size:12px}
.dbb-modal-box.wide{width:min(1040px,94vw);max-width:min(1040px,94vw)}
/* D-027: Open dashboard dialog. Divs + grid (not <table>) so ThingsBoard's table styles can't change font or size. */
.dbb-od,.dbb-od *{font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box}
.dbb-od-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0 12px}
.dbb-od-count{font-size:13px;color:#5c6470}
.dbb-od-list{border:1px solid #e6e8ec;border-radius:10px;overflow:auto;max-height:56vh}
.dbb-od-row{display:grid;grid-template-columns:minmax(220px,2.2fr) minmax(130px,1.2fr) 80px minmax(130px,1.3fr) minmax(170px,1.4fr);column-gap:24px;align-items:center;padding:11px 18px;border-bottom:1px solid #eef0f3;font-size:13.5px;color:#1f2933;line-height:1.35}
.dbb-od-row:last-child{border-bottom:none}
.dbb-od-head{position:sticky;top:0;z-index:1;background:#f7f8fa;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6b7380;padding-top:10px;padding-bottom:10px}
.dbb-od-body .dbb-od-row{cursor:pointer;transition:background .12s}
.dbb-od-body .dbb-od-row:hover,.dbb-od-body .dbb-od-row:focus-visible{background:#f1f6fd;outline:none}
.dbb-od-name{font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbb-od-name .dbb-od-sub{font-weight:400;color:#8a919c;margin-left:6px;font-size:12px}
.dbb-od-type{justify-self:start;display:inline-block;font-size:12px;font-weight:500;padding:3px 10px;border-radius:999px;background:#eaf2fd;color:#1d5fb8;white-space:nowrap}
.dbb-od-type.sa{background:#f1eefd;color:#5b3fc4}
.dbb-od-num{text-align:right;font-variant-numeric:tabular-nums}
.dbb-od-muted{color:#5c6470;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbb-od-muted small{color:#8a919c;font-size:12px}
.dbb-od-empty{padding:28px;text-align:center;color:#6b7380;font-size:13px}
@media (max-width:760px){.dbb-od-row{grid-template-columns:1fr auto;row-gap:4px}.dbb-od-row>:nth-child(n+3){display:none}}
.dbb-pick tbody tr{cursor:pointer}
.dbb-pick tbody tr:hover{background:#f3f8fe}
.dbb-toasts{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;z-index:40}
.dbb-toast{background:#1a1a19;color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;max-width:70vw;box-shadow:0 6px 18px rgba(0,0,0,.2);animation:dbbfade .2s ease-out}
.dbb-toast.err{background:#8e2222}
.dbb-toast.warn{background:#7a5200}
@media (max-width:1100px){.dbb-left{width:170px}.dbb-palette{grid-template-columns:1fr}.dbb-right{width:300px}.dbb-tpl-grid.mini{grid-template-columns:1fr 1fr}}
`;
