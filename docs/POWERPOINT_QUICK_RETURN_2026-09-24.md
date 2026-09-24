# Faster return from PDF to PowerPoint

Live diagnostics on the external Program display showed PPTX return taking
5–6 seconds, with one 10-second outlier. In the outlier, a previously acknowledged
PPTX CLOSE continued retiring an owned PowerPoint process for about five seconds;
the next OPEN waited behind that cleanup and then started Office and its slide
show from scratch. This was independent of the recent asynchronous PDF-preview
encoding change.

On a successful PPTX → PDF TAKE, the native slideshow and its Presentation are
still closed only after the PDF has painted. The empty PDM-owned PowerPoint host
is now retained for a 20-second return window. An IPC timer asks the serialized
daemon to release it afterward. The daemon checks for an open transaction,
active slideshow markers and presentation counts before retirement. Explicit
STOP, failures and application shutdown retain their existing cleanup behavior;
a borrowed user PowerPoint process is never put on this lease.

The retention is deliberately limited to an empty Office host. It avoids
keeping an embedded video/media graph or multiple large decks resident. A
return after the window expires still has the normal cold-start cost.

Verification: strict TypeScript and Stream production build passed; the
PowerShell parser and existing PowerPoint recovery tests passed; 21 race tests
passed. The new idle-host test exercises the actual PowerShell release function:
short hold, scheduled release, refusal to retire an active deck, and immediate
cleanup on a failed OPEN. After restarting PDM, its three prepared channels were
verified unchanged. Real physical-output transitions returned to PPTX in about
1.1–1.6 seconds during the short hold in ordinary and Scene modes. A physical
screen capture showed the correct live PPTX slide. Scheduled release ran and
reported success; a subsequent cold return worked. PDM was left open, with the
Scene mode restored to its pre-test disabled state.

No commit or release was made. The quick-return limit and additional temporary
memory for an empty PowerPoint process remain intentional tradeoffs.
