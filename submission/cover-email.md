# Draft cover email

**To:** [interviewer's email]
**Subject:** TN EC Integration Feasibility — assessment attached

---

Hi [interviewer name],

Thanks again for the assignment — attached is my write-up on Tamil Nadu
Encumbrance Certificate integration feasibility, plus a short demo of the POC.

**Headline finding:** no government API exists (confirmed against TNREGINET and
API Setu directly). The workable path is a licensed third-party data provider
(Landeed/SurePass) as the primary source, with supervised browser automation as
a fallback — both sitting behind one internal service, since a human still has
to clear CAPTCHA/OTP either way. Certified copies are asynchronous on every
route, since a government officer has to sign them.

Attached:
1. **TN-EC-Summary-Plain-Language.pdf** — the short version, no jargon: what's
   possible, what isn't, and what we'd recommend.
2. **TN-EC-Feasibility-Report.pdf** — the full technical assessment: API/portal
   findings, third-party comparison, blockers, and the detailed architecture.
3. **TN-EC-Production-Architecture.pdf** — a visual walkthrough of how the
   production system would actually be built: the request flow diagram, what's
   essential vs. what can come later, and the tools it's built from.
4. **POC-Demo-Walkthrough.gif / .webm** — a ~30s recording of the flow working
   end to end, including the human-in-the-loop CAPTCHA step (see
   `POC-Summary.md` for what it shows).

Happy to walk through any of it live, or go deeper on the architecture side.

Best,
Raakesh
