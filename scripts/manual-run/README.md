# Manual parallel-agent run (held-out, 2026-10-25)

Not the product. On Clemente's order the held-out file was built by one agent per 12-page window
of the expected regulations, outside the pipeline. These are the exact commands, so each uploaded
file (`run-<commit>.json`) can be rebuilt. The work directory (windows, agent outputs) is not in
the repo: it holds regulation text.

    DROPS='--drop "UN R10|Appendix 6" --drop "UN R10|Appendix 7" --drop "UN R10|Annex 7 4.1"
      --drop "UN R10|Annex 8 4.1" --drop "UN R10|Annex 9 1.2.1" --drop "UN R10|Annex 9 3.1"
      --drop "UN R10|Annex 10 2" --drop "UN R10|Annex 10 3" --drop "UN R148|4.7.1"'
    python3 merge_windows.py $WORK team-09 heldout-front-bumper out.json $DROPS [--extra ...]

The drops are agent items that repeat a limit already written from the main text (and one rule
for replaceable light sources the brief excluded).

| File | --extra from heldout-front-bumper-scoped.json | Platform F2 |
|---|---|---|
| run-000b5f2 | none (259) | 0.600 |
| run-90e5c3b | side direction-indicator reading, REESS charging (29) | 0.580: the 29 matched nothing |
| run-<this commit> | replaceable light-source and module rules, aerials, lower legform tolerances (29) | pending |

Why the third: on the dev case the experts wrote the "in case of replaceable light source
modules" obligations although the case did not show replaceable modules; the brief left them out.
The bumper carries a keyless-entry aerial; the brief read the aerial rules as outside aerials only.
