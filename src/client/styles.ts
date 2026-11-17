export const styles = `
.dte{display:inline-flex;flex:0 1 auto;max-width:100%;color:var(--dsw-alias-label-secondary);font:inherit;line-height:inherit;min-width:0;box-sizing:border-box}
.dte *{box-sizing:border-box}
.dte button,.dte input,.dte textarea,.dte select{font:inherit;color:inherit}
.dte button,.dte summary{cursor:pointer}
.dte button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:6px;min-height:32px;padding:4px 10px;transition:background-color .15s,border-color .15s}
.dte button:hover:not(:disabled),.dte summary:hover{background:var(--dsw-alias-bg-layer-2)}
.dte button:disabled{cursor:default;opacity:.6}
.dte button:focus-visible,.dte summary:focus-visible,.dte input:focus-visible,.dte textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dte button.dte-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dte button.dte-danger{color:var(--dsw-alias-state-error-primary)}
.dte .dte-quiet{border-color:transparent;background:transparent}
.dte .dte-muted{color:var(--dsw-alias-label-secondary)}
.dte .dte-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dte .dte-warn{color:var(--dsw-alias-state-warn-primary)}
.dte .dte-success{color:var(--dsw-alias-state-success-primary)}
.dte .dte-small{font-size:.9em}
.dte .dte-tabular{font-variant-numeric:tabular-nums}
.dte details>summary{list-style:none}
.dte details>summary::-webkit-details-marker{display:none}
.dte .dte-main{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:4px 6px;border-radius:5px;flex-wrap:wrap;overflow-wrap:anywhere;text-align:left}
.dte .dte-main .dte-chevron{width:12px;height:12px;flex:none;transition:transform .15s}
.dte details[open]>.dte-main .dte-chevron{transform:rotate(90deg)}
.dte .dte-main .dte-main-text{display:flex;gap:4px 12px;flex:1;flex-wrap:wrap;min-width:0;align-items:baseline}
.dte .dte-main .dte-value{font-weight:500}
.dte .dte-state{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dte .dte-state::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dte .dte-state[data-state=running]::before{background:var(--dsw-alias-brand-primary)}
.dte .dte-state[data-state=completed]::before{background:var(--dsw-alias-state-success-primary)}
.dte .dte-state[data-state=failed]::before{background:var(--dsw-alias-state-error-primary)}
.dte .dte-panel{margin:4px 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);max-height:min(60vh,38rem);overflow:auto;overscroll-behavior:contain;padding:12px;scrollbar-gutter:stable}
.dte .dte-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
/* Any spacer pushes what follows to the far edge; the header needs it too, or
   the close button sits next to the title instead of at the panel's right. */
.dte .dte-spacer{flex:1}
.dte .dte-subsection{border-top:1px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:10px}
.dte .dte-subsection>summary{padding:3px 0;min-height:30px;display:flex;align-items:center;gap:6px;font-weight:500}
.dte .dte-subsection>summary::before{content:'›';display:inline-block;font-weight:400;transition:transform .15s}
.dte .dte-subsection[open]>summary::before{transform:rotate(90deg)}
.dte h3{font-size:inherit;margin:0 0 8px;font-weight:600}
.dte p{margin:6px 0;overflow-wrap:anywhere}
.dte dl.dte-facts{display:grid;grid-template-columns:minmax(7rem,1fr) minmax(0,2fr);gap:5px 12px;margin:8px 0}
.dte .dte-facts dt{color:var(--dsw-alias-label-secondary)}
.dte .dte-facts dd{margin:0;overflow-wrap:anywhere;min-width:0;font-variant-numeric:tabular-nums}
.dte .dte-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px}
.dte .dte-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dte input,.dte textarea{width:100%;min-width:0;min-height:32px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:5px 7px}
.dte textarea{resize:vertical;line-height:1.5;min-height:112px;tab-size:2}
.dte .dte-code{font-family:inherit;font-variant-numeric:tabular-nums;white-space:pre;overflow:auto}
.dte .dte-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px}
.dte .dte-confirm{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:5px;padding:9px;margin-top:8px}
.dte ul{padding-inline-start:20px;margin:6px 0}
.dte li{overflow-wrap:anywhere;margin:4px 0}
.dte .dte-profiles{list-style:none;padding:0;margin:8px 0;display:flex;flex-direction:column;gap:8px}
.dte .dte-profiles>li{display:flex;flex-direction:column;gap:1px;min-width:0;margin:0;padding:0;overflow-wrap:anywhere}
.dte .dte-table-wrap{overflow:auto;max-width:100%}
.dte table{width:100%;border-collapse:collapse;text-align:start;font-size:inherit}
.dte th,.dte td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;overflow-wrap:anywhere}
.dte th{font-weight:500;color:var(--dsw-alias-label-secondary);text-align:start}
.dte .dte-status{min-height:1.5em;margin:6px 0}
.dte a{color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}
/* Native StatsPills / TurnUsagePanel geometry (MIT), without private imports.
   Both roots shrink-wrap; neither claims the composer's available width. */
.dte[data-slot=composer-dock]{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dte button.dte-line{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;min-height:0;padding:1px 8px;background:transparent;border:0;border-radius:var(--dsw-radius-sm);text-align:left;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;transition:none}
.dte button.dte-line[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media(hover:hover){.dte button.dte-line:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dte .dte-line-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dte .dte-line-clock{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
@media(max-width:480px){.dte .dte-line-clock{display:none}}
.dte button.dte-line-tail{gap:4px;height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px 8px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.dte button.dte-line-tail[aria-expanded=true],.dte button.dte-line-tail:hover:not(:disabled){color:var(--dsw-alias-label-tertiary)}
.dte .dte-icon{flex:none;width:14px;height:14px;color:inherit;overflow:visible}
.dte .dte-line-tail .dte-icon{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.dte .dte-icon-ring{display:none}
.dte .dte-chip{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:.85em;white-space:nowrap;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 8px;line-height:1.7}
/* Native stat-dialog surface (MIT). Owned-element measurements place the
   body portal with the native gap/inset and a bounded internal scroll area. */
.dte .dte-pop{position:fixed;inset:auto;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)));overflow-x:hidden;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);top:max(12px,var(--dsh-frame-overlay-top,12px));left:12px;height:auto;min-height:0;margin:0;overscroll-behavior:contain;container-type:inline-size}
.dte .dte-pop-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.dte .dte-pop-title{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1}
.dte button.dte-more{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;min-height:24px;width:24px;padding:2px;margin:-3px -4px -3px -8px;color:var(--dsw-alias-label-tertiary)}
.dte .dte-pop-actions[hidden]{display:none}
/* Summary reading order: one hero figure (how long), one picture of the
   range, then compact cards. Nothing repeats the hero value. */
.dte .dte-hero{display:flex;align-items:baseline;gap:8px;margin:10px 0 0}
.dte .dte-hero-value{color:var(--dsw-alias-label-primary);font-size:27px;line-height:1.15;font-weight:600;letter-spacing:-.015em;font-variant-numeric:tabular-nums}
.dte .dte-hero-caption{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
/* The summary reads top-down: answer, timeline, then one bar per dimension.
   A real timeline puts "now" at a position instead of between two numbers. */
.dte .dte-timeline{margin:12px 0 0}
.dte .dte-timeline-track{position:relative;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.dte .dte-timeline-done{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 80%,transparent)}
.dte .dte-timeline-band{position:absolute;top:0;bottom:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}
.dte .dte-timeline-now{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--dsw-alias-label-primary);transform:translateX(-1px)}
.dte .dte-timeline-dot{position:absolute;top:50%;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-bg-base);border:2px solid var(--dsw-alias-brand-primary);transform:translate(-50%,-50%)}
.dte .dte-timeline-labels{display:flex;justify-content:space-between;gap:12px;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dte .dte-status-line{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dte .dte-finish{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}
.dte .dte-source{margin-left:2px}
.dte .dte-fieldset{margin:0 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-width:0}
.dte .dte-fieldset legend{padding:0 4px;color:var(--dsw-alias-label-secondary);font-weight:500}
.dte .dte-check{display:flex;align-items:center;gap:8px}
.dte .dte-check input{width:auto;min-height:0}
.dte .dte-switch-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.dte .dte-switch{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dte .dte-switch input{width:auto;min-height:0;margin:0}
.dte .dte-trail{display:flex;align-items:center;gap:8px;margin:10px 0 0}
.dte .dte-trail-caption{color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap}
.dte .dte-trail-bars{display:flex;align-items:flex-end;gap:2px;height:18px;flex:1;min-width:0}
.dte .dte-trail-bars i{flex:1;min-width:3px;max-width:10px;border-radius:2px 2px 0 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dte .dte-status{margin:10px 0 0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:1.4;font-weight:500}
.dte .dte-status-plain{font-size:14px;font-weight:500}
.dte .dte-tip-subject{cursor:help}
/* display:contents paints nothing, so the ring goes on the child the keyboard user reached. */
.dte .dte-tip-subject:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:6px}
.dte button:focus-visible, .dte a:focus-visible, .dte [tabindex]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}
.dte-tip-card{transition:opacity .12s ease}
.dte-tip-card{position:fixed;box-sizing:border-box;z-index:2000000000;max-width:260px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:none}
.dte .dte-goal{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dte .dte-goal-line{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dte .dte-activity{display:flex;align-items:center;gap:10px;margin:12px 0 0}
.dte .dte-activity-counts{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dte .dte-activity-band{display:flex;align-items:flex-end;gap:2px;height:16px;flex:1;min-width:0}
.dte .dte-activity-band i{flex:1;min-width:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.dte .dte-activity-quiet{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:1}
.dte .dte-facts{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:14px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dte .dte-facts b{color:var(--dsw-alias-label-primary);font-weight:600;margin-left:3px}
.dte .dte-metrics{display:flex;flex-direction:column;gap:14px;margin:16px 0 0}
.dte .dte-metric-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dte .dte-metric-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.dte .dte-metric-share{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dte .dte-bar{position:relative;height:6px;margin:5px 0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dte .dte-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent)}
.dte .dte-bar-unknown{background-image:repeating-linear-gradient(90deg,var(--dsw-alias-border-l1) 0 4px,transparent 4px 8px)}
.dte .dte-metric-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}
.dte .dte-metric-values>div{min-width:0}
.dte .dte-metric-values dt{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.3}
.dte .dte-metric-values dd{display:flex;align-items:baseline;gap:4px;margin:1px 0 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.35;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
@container (max-width:300px){.dte .dte-metric-values{grid-template-columns:repeat(2,minmax(0,1fr))}.dte .dte-metric-values>div:last-child{grid-column:1/-1}}
@media(pointer:coarse){.dte button,.dte summary,.dte input{min-height:44px}.dte textarea{font-size:max(1em,16px)}}
/* Reduced motion must also stop the looping state icon, not only transitions. */
@media(prefers-reduced-motion:reduce){.dte *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}

/* Visual dashboard: the same numbers as the sentence, drawn instead of written. */
.dte .dte-hero{display:flex;align-items:center;gap:14px;margin:16px 0 0}
.dte .dte-ring{flex:0 0 64px;width:64px;height:64px}
.dte .dte-ring-track{fill:none;stroke:var(--dsw-alias-bg-layer-2);stroke-width:6}
.dte .dte-ring-fill{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:6;stroke-linecap:round;transition:stroke-dasharray .4s ease}
.dte .dte-ring-done .dte-ring-fill{stroke:var(--dsw-alias-label-tertiary)}
.dte .dte-hero-figures{min-width:0;flex:1 1 auto}
.dte .dte-hero-value{font-size:26px;line-height:1.15;font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.dte .dte-hero-value-plain{font-size:22px}
.dte .dte-hero-caption{font-size:12px;line-height:1.35;color:var(--dsw-alias-label-tertiary);white-space:normal}
.dte .dte-track{position:relative;height:8px;margin:16px 0 0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dte .dte-track-spent{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.dte .dte-track-band{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent);border-radius:0 999px 999px 0}
.dte .dte-track-now{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;border-radius:2px;background:var(--dsw-alias-label-primary)}
.dte .dte-finish-row{display:flex;flex-wrap:wrap;gap:4px 10px;margin:8px 0 0}
.dte .dte-finish-row .dte-finish{margin:0}
.dte .dte-goal-head{display:flex;align-items:center;gap:10px}
.dte .dte-goal-count{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dte .dte-rounds{display:flex;gap:3px;flex:1 1 auto;min-width:0}
.dte .dte-rounds i{flex:1 1 0;min-width:2px;max-width:14px;height:6px;border-radius:2px}
.dte .dte-round-on{background:var(--dsw-alias-brand-primary)}
.dte .dte-round-off{background:var(--dsw-alias-bg-layer-2)}
.dte .dte-goal-spent{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dte .dte-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0 0;flex-wrap:nowrap}
.dte .dte-chips{display:flex;gap:5px;flex-wrap:nowrap;justify-content:flex-end;min-width:0;overflow:hidden}
.dte .dte-chip{padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dte .dte-activity{display:flex;align-items:flex-end;gap:2px;height:16px;width:64px;margin:0}
.dte .dte-activity-band{display:flex;align-items:flex-end;gap:2px;height:16px;flex:1 1 auto;min-width:0}
.dte .dte-activity-band i{flex:1;min-width:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.dte .dte-activity-quiet{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
`;
