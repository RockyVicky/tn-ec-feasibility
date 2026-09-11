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
1. **TN-EC-Feasibility-Report.pdf** — the full assessment: API/portal findings,
   third-party comparison, blockers, and the recommended architecture.
2. **POC-Demo-Walkthrough.gif / .webm** — a ~30s recording of the flow working
   end to end, including the human-in-the-loop CAPTCHA step (see
   `POC-Summary.md` for what it shows).

Happy to walk through any of it live, or go deeper on the architecture side.

Best,
Raakesh
