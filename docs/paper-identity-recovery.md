# Paper identity collision recovery

On 2026-09-08, GardenOfPapers contained two different papers with the same DOI.
Legacy-save reconciliation and browser-draft recovery could map both papers to
one Mongo ID. The PDF library also accepted the DOI despite contradictory
titles. The resulting object retained Threddy's notes and highlights but used
the title, position, client key and PDF alias of the unrelated search result.

The web client now reconciles IDs one-to-one, reserves existing IDs, rejects
conflicting client keys, and never uses a DOI alone to remap an object. Stale
drafts cannot overwrite a repaired canonical identity. Delayed PDF completion
and server polls are checked again before updating the board. The server rejects
duplicate IDs/client keys and identity changes during normal saves; explicit
history restoration remains available. PDF reuse rejects contradictory titles.

## Selective recovery

`planPaperRecovery` restores a paper's identity, bibliographic/PDF metadata and
position from a known good snapshot. It retains current highlights, excerpts,
translations, notes, links, other objects and the current camera. It refuses
ambiguous originals, conflicting identities and a changed expected revision.

`scripts/recover-threddy.js` is deliberately scoped to this incident and its
verified snapshot/PDF identities. It defaults to a dry run:

```powershell
node scripts/recover-threddy.js --expected-revision 850 --backup-dir ../gop-web/output/threddy-recovery-2026-09-08
```

Review the proposed fields and backup before adding `--apply`. The script writes
a BSON EJSON backup before any database mutation. A Mongo transaction compares
the backed-up documents again and atomically repairs the canonical snapshot,
legacy paper, PDF aliases and library identity index. Concurrent changes abort
the transaction. It does not delete the PDF binary, rewind other board work,
modify manual snapshots, or create automatic history snapshots.

This incident was applied at revision 850 → 851. Verification confirmed the
original Threddy identity/PDF, seven attached notes, six highlights and all forty
other objects unchanged. All five existing manual snapshots remain intact.
The repair backup and verification report are stored outside Git under the
requested backup directory. An old historical snapshot can still contain the
original unrelated search result; history is preserved, not rewritten.

The replacement local server must run the new guards before repairing live data.
Browsers should reload the corrected web build; an older web deployment still
needs its own release. This work did not deploy the hosted frontend.
