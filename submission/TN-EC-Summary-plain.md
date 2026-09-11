# Can we pull Tamil Nadu property certificates automatically?

**A plain-language summary.** A more detailed technical version of this
assessment is available on request.

## The question we set out to answer

Property deals need an **Encumbrance Certificate (EC)** - the official document
showing whether a property has any loans, disputes, or other claims registered
against it. Today, getting one means a person manually visits a government
website, fills in the details, and waits. The client wants to know: **can this
be done automatically, feeding straight into their own systems, with no one
having to do it by hand?**

## The short answer

**Mostly, yes - but not completely, and one part will always need a person.**

There is no official government shortcut for this (more on that below), so the
practical path is: use a specialist company that already does this well, back
it up with our own automated approach, and accept that a human always has to
handle one specific step. That's not a limitation of our approach - every
company that does this today, including the big players, runs into the same
wall.

## What we found

- **There's no government API to plug into.** We checked directly with the
  official Tamil Nadu registration website and with India's central government
  API directory. Neither offers a way to look up an Encumbrance Certificate
  programmatically. This isn't a case of us missing a menu option - it simply
  doesn't exist yet.
- **Companies that offer this already exist**, and they charge for it. A
  handful of specialist providers sell exactly this - instant property record
  lookups - as a paid service. They've already solved the hard parts, so buying
  access from one of them is the fastest, lowest-risk way to get this working.
- **Doing it ourselves directly is possible, but harder and riskier.** We could
  build a program that fills in the government website automatically, the same
  way a person would. It works, but the government's own website is not
  designed to allow this, and it puts up a deliberate obstacle for exactly this
  reason (see below). It's a reasonable backup plan, not a first choice.

## What we actually built and tested

Rather than just write this up, we built a small working version of the whole
idea and ran it end to end. It takes a property's details, looks it up, and
gives back a clear answer, including correctly recognising when it *doesn't*
know something for certain, instead of guessing. A short recording of this
running live is included alongside this summary.

## The one thing that will never be fully automatic

Government websites protect against automated access with a **CAPTCHA** - the
"type the wiggly letters you see in this image" check designed specifically to
tell a computer program apart from a real person. There is no clean way around
this, and we don't believe there should be - it exists on purpose, as a
security control.

**Our approach: a person is always kept in the loop for this one step**, and
nothing else. The system does everything else automatically, pauses exactly
when it hits this check, shows the image to a person, and continues the moment
they type the answer. Everywhere else, it runs on its own.

## What we recommend

**A combined approach:**

1. **Primary route:** pay one of the specialist providers for access. This is
   the fastest and lowest-risk way to get real results flowing.
2. **Backup route:** keep our own automated version ready, for cases the paid
   provider can't cover, or if we ever need to negotiate a better deal.
3. **Always keep a person on standby** for the CAPTCHA step and for double-checking
   anything unclear (like a search that comes back with "nothing found," which
   needs a human to confirm before anyone treats it as good news).

## Timing and cost, in plain terms

| | What to expect |
|---|---|
| **A regular (informational) certificate** | Back in minutes |
| **An official, government-signed copy** | Several days to over a week - a real government officer has to personally sign it, on every possible route, no exceptions |
| **Cost** | A small per-lookup fee to the specialist provider; building our own backup has its own ongoing cost in hosting and staff time |

## Decisions we'd need from the client to move forward

1. Roughly how many lookups per month, and how many need the official signed version?
2. Which parts of Tamil Nadu are in scope?
3. Is "minutes for a regular copy, days for an official one" an acceptable timeline?
4. Who would staff the "type the CAPTCHA" step day to day?
5. How comfortable is the client with us running our own automated backup
   against the government site, versus relying only on a paid provider?

## Bottom line

This is achievable, and a working version already exists to prove it. The
realistic target is **"almost completely automatic, with one small, well-defined
human step, and honest expectations about the government's own timelines"** -
not a claim that this can be made 100% hands-off, because it genuinely can't be,
by design of the system we're working with.
