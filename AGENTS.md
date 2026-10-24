# PAB source-development rules

These instructions apply to **changes to this repository**, not to tasks executed *by* the PAB bridge. The owning collaboration policy lives in `danielnguyen/projects/process/chatgpt-controller-contract.md` (PAB source-development pilot). Read the supplied current policy and task scope before implementation; if required governance is unavailable, say so instead of guessing.

- Work only within the files and outcome explicitly authorized for the task. Use a branch and a pull request; never push directly to `main`. Do not create new processes, planning documents, services, queues, or scripts merely to coordinate agents.
- Run the relevant tests and report exactly what ran. `npm test` is the full local regression suite, requiring a compatible Linux/Codex sandbox host. `npm run test:live` uses paid real sessions and is **never** routine CI or implicitly authorized.
- GitHub PRs are the shared record for diffs, check results and findings. Keep PR descriptions understandable: outcome, before/after, evidence, known limitations. Do not make the owner relay evidence already accessible through GitHub.
- Preserve independent review against the **current** PR head and applicable owner-operated host acceptance. A portable CI pass or self-review never substitutes for mandatory SSH B / SSH C evidence. No waiver of security, sandbox, exact-tree or publication requirements.
- Do not access `nasuko-compute` or `unicomplex-compute-2` directly or indirectly. Do not merge, deploy, use privileged credentials, expand registered repositories or write to protected hosts without separately applicable owner authorization. Stop when the scope or evidence is uncertain.
- After one focused correction round, escalate repeated failures with a short, plain-language explanation. Do not keep inventing investigations or new tooling.

This repository's `SECURITY.md` and `VERIFICATION.md` remain authoritative for its runtime security model and testing limitations. The pilot does **not** change the PAB Controller's draft-only publication and merge restrictions.
