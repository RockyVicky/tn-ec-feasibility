# Draft cover email

**To:** [interviewer's email]
**Subject:** TN EC Integration Feasibility — assessment + live test update

---

Hi [interviewer name],

Thanks again for the assignment. Attached is the write-up on Tamil Nadu
Encumbrance Certificate integration feasibility, along with an update: since
the original submission I ran the automation against the **real**
`tnreginet.gov.in` site for the first time (previously only tested against a
stand-in copy), found one bug, and root-caused it live.

**Full project (dashboard, both demo videos, code, test suite):**
[GITHUB_REPO_LINK]

**Headline finding, unchanged:** no government API exists for EC lookup
(confirmed directly against TNREGINET and API Setu). The workable path is a
licensed third-party data provider (Landeed/SurePass) as the primary source,
with supervised browser automation as a fallback — both behind one internal
service, since a human still has to clear CAPTCHA/OTP either way. Certified
copies stay asynchronous on every route, since a government officer has to
sign them by hand.

**What the live test against the real site showed:** location fields,
CAPTCHA, and the CAPTCHA-verification call all worked correctly on the first
try. The only step that didn't was the "EC Start/End Date" calendar fields —
the site's own front-end validation silently refused to submit because of how
the automated browser was filling those two boxes (details + full evidence
trail in the report, §6.5). The fix is written and mostly working, with one
small correction left. **This doesn't change the recommendation — if
anything it confirms it:** it's exactly the kind of maintenance risk that's
already the reason this plan treats our own automation as a fallback, not
the primary path.

**Recommendation: yes, continue as planned** — hybrid, aggregator-first. See
the dashboard link above for the plain-language verdict, and the report for
the full reasoning.

Attached:
1. **TN-EC-Summary-Plain-Language.pdf** — the short version, no jargon: what's
   possible, what isn't, what changed with tonight's live test, and what we
   recommend.
2. **TN-EC-Feasibility-Report.pdf** — the full technical assessment: API/
   portal findings, third-party comparison, blockers, architecture, and the
   live-test root-cause writeup (§6.5) and a batch-processing extension idea
   (§8.4).
3. **POC-Demo-Walkthrough.gif** — a ~30s preview of the core flow working end
   to end against a stand-in portal (full video + the live-site recording are
   both in the repo linked above).

Also in the repo, not attached here (larger files / better viewed there):
- **TN-EC-Production-Architecture.pdf** — visual walkthrough of the
  production build: request-flow diagram, what's essential vs. later, tools
  used.
- **TN-EC-Before-After-Comparison.pdf** — side-by-side of the manual process
  today vs. with this system.
- The **project dashboard** (`service/public/dashboard.html`) — the single
  best place to see everything together: both demo videos, the architecture
  diagram, the go/no-go call, and a "search many properties at once" idea
  using the same design.

Happy to walk through any of it live, or go deeper on the architecture side.

Best,
Raakesh
