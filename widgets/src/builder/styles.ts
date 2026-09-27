export const BUILDER_CSS = `
.dbb-overlay{position:fixed;inset:0;z-index:10000;background:#f6f6f4;display:flex;flex-direction:column}
.dbb-top{display:flex;align-items:flex-end;gap:10px;padding:10px 14px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.dbb-brand{font-size:16px;font-weight:500;align-self:center;margin-right:6px;white-space:nowrap}
.dbb-field{display:flex;flex-direction:column;gap:3px;font-size:12px;min-width:0}
.dbb-field>span{color:var(--ink-3);font-size:11px}
.dbb-field.grow{flex:1;min-width:160px}
.dbb-field.half{flex:1}
.dbb-field input,.dbb-field select,.dbb-field textarea,.dbb-sub select,.dbb-bands input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);min-width:0}
.dbb-field textarea{resize:vertical}
.dbb-bands{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--ink-2)}
.dbb-bands input{width:70px}
.dbb-tools{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
.dbb-btn.icon{padding:6px 9px;font-size:15px;line-height:1}
.dbb-btn.sm{padding:3px 8px;font-size:12px}
.dbb-btn.danger-fill{background:var(--danger);border-color:var(--danger)}
.dbb-banner-row{display:flex;flex-direction:column;gap:4px;padding:6px 14px 0}
.dbb-banner-row[hidden]{display:none}
.dbb-main{flex:1;display:flex;min-height:0}
.dbb-left{width:190px;background:#fff;border-right:1px solid var(--line);padding:12px;overflow:auto;flex:none}
.dbb-right{width:330px;background:#fff;border-left:1px solid var(--line);display:flex;flex-direction:column;flex:none;min-height:0}
.dbb-left[hidden],.dbb-right[hidden]{display:none}
.dbb-center{flex:1;overflow:auto;position:relative;min-width:0}
.dbb-canvas{margin:4px;min-height:400px;background-image:linear-gradient(to right,rgba(0,0,0,.035) 1px,transparent 1px);background-size:calc((100% - 10px)/12) 100%;background-position:5px 0;border-radius:8px}
.dbb-canvas.preview{background-image:none}
.dbb-canvas.preview .dbb-gdrag,.dbb-canvas.preview .dbb-gresize{display:none}
.dbb-sec{font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3);margin:12px 0 6px}
.dbb-sec:first-child{margin-top:0}
.dbb-palette{display:grid;grid-template-columns:1fr;gap:6px}
.dbb-pal{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:grab;font:inherit;color:var(--ink);text-align:left}
.dbb-pal:hover{border-color:var(--accent);background:#f3f8fe}
.dbb-pal svg{width:20px;height:20px;flex:none;color:var(--accent)}
.dbb-hint{font-size:12px;color:var(--ink-3);margin:6px 0;line-height:1.4}
.dbb-muted{color:var(--ink-3);font-size:11px}
.dbb-count{font-size:12px;color:var(--ink-2)}
.dbb-tabs{display:flex;border-bottom:1px solid var(--line);flex:none}
.dbb-tab{flex:1;border:0;background:none;padding:10px;font:inherit;color:var(--ink-2);cursor:pointer;border-bottom:2px solid transparent}
.dbb-tab.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:500}
.dbb-panel{flex:1;overflow:auto;padding:12px;min-height:0;display:flex;flex-direction:column}
.dbb-form{display:flex;flex-direction:column;gap:8px}
.dbb-row{display:flex;gap:8px;align-items:flex-end}
.dbb-row.wrap{flex-wrap:wrap}
.dbb-check{display:flex;align-items:flex-start;gap:6px;font-size:13px;cursor:pointer;line-height:1.35}
.dbb-check input{margin-top:2px}
.dbb-check.dis{opacity:.55;cursor:default}
.dbb-src{display:flex;flex-direction:column;gap:6px}
.dbb-sub{margin-left:22px;display:flex;flex-direction:column;gap:6px;font-size:12px}
.dbb-sub[hidden]{display:none}
.dbb-keys{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;padding:6px;border:1px solid var(--grid);border-radius:6px}
.dbb-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1}
.dbb-empty[hidden]{display:none}
.dbb-empty-card{pointer-events:auto;background:#fff;border:1px dashed #c9c8c2;border-radius:10px;padding:22px 26px;max-width:460px;text-align:center}
.dbb-empty-t{font-size:16px;font-weight:500;margin-bottom:6px}
.dbb-empty-s{font-size:13px;color:var(--ink-2);margin:6px 0}
.dbb-empty-a{display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap}
.dbb-busy{position:absolute;right:16px;bottom:16px;background:#1a1a19;color:#fff;border-radius:8px;padding:8px 12px;display:flex;gap:8px;align-items:center;font-size:12px;z-index:20}
.dbb-busy[hidden]{display:none}
.dbb-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:dbbspin .8s linear infinite}
@keyframes dbbspin{to{transform:rotate(360deg)}}
.dbb-chat{display:flex;flex-direction:column;height:100%;gap:8px;min-height:0}
.dbb-chat-log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:120px}
.dbb-msg{padding:8px 10px;border-radius:10px;font-size:13px;line-height:1.4;max-width:92%}
.dbb-msg.user{background:#2a78d6;color:#fff;align-self:flex-end}
.dbb-msg.assistant{background:#f1f0ec;align-self:flex-start}
.dbb-msg.system{background:none;color:var(--ink-3);font-size:12px;align-self:center;padding:2px}
.dbb-msg-sum{font-size:11px;color:var(--ink-2);margin-top:4px}
.dbb-msg-sum a{color:var(--accent)}
.dbb-opts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dbb-chat-bar{display:flex;gap:6px;flex-wrap:wrap}
.dbb-chat-form{display:flex;gap:6px;align-items:flex-end}
.dbb-chat-form textarea{flex:1;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;resize:none}
.dbb-typing{color:var(--ink-3)}
.dbb-modal{position:absolute;inset:0;background:rgba(10,10,10,.35);display:flex;align-items:center;justify-content:center;z-index:30}
.dbb-modal-box{background:#fff;border-radius:10px;min-width:360px;max-width:min(720px,92vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.dbb-modal-h{font-size:16px;font-weight:500;padding:14px 16px 6px}
.dbb-modal-b{padding:6px 16px;overflow:auto;font-size:13px;line-height:1.45}
.dbb-modal-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px}
.dbb-preview{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dbb-pick tbody tr{cursor:pointer}
.dbb-pick tbody tr:hover{background:#f3f8fe}
.dbb-toasts{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;z-index:40}
.dbb-toast{background:#1a1a19;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;max-width:70vw}
.dbb-toast.err{background:#8e2222}
.dbb-toast.warn{background:#7a5200}
@media (max-width:900px){.dbb-left{width:140px}.dbb-right{width:260px}}
`;
