/**
 * The scoring rubric.
 *
 * Two things about this file are load-bearing and easy to break by accident.
 *
 *   1. RUBRIC must be byte-identical on every call. It is sent as a cached
 *      system block, and prompt caching is a prefix match: interpolating an ad
 *      id, a team name or a date into it silently drops the hit rate to zero
 *      with no error anywhere. Nothing is interpolated. Ever.
 *
 *   2. Any edit to RUBRIC must bump RUBRIC_VERSION. Scores are cached on
 *      (ad, rubric version), so an unbumped edit makes old and new scores
 *      quietly non-comparable while still looking like one scale.
 *
 * v2 scores from the written record produced by src/understand, not from the
 * frames directly. The frames are watched once, by a model chosen for seeing;
 * this call judges what was seen. That makes scoring fast and cheap, makes a
 * rubric edit cheap to re-run, and lets an ad whose CDN links died last month
 * still be re-scored. It costs something real on the production axis, which is
 * a pixel judgement now made from a description - so the rubric says to score
 * what the record supports rather than guessing past it.
 *
 * The bands are the actual mechanism. Sonnet rejects temperature, top_p and
 * top_k outright, so there is no sampling knob to turn down for stability: the
 * only lever left is making the scale concrete enough that two runs land in the
 * same band. The anti-7 rule is what stops everything drifting to mid-scale.
 */

export const RUBRIC_VERSION = "rubric_v2";

export const RUBRIC = `You are scoring one video advertisement. You are given a written record of it: what the product is, who it is for, the hook, the beats in order with timestamps, observed production detail, and the ad's own copy. Somebody else watched the frames and wrote this down. Your job is to judge what they recorded, not to imagine past it.

Score four axes out of 10. For each axis, in this order: quote the evidence from the record, name the beat it came from, choose a band, then give the number. The number is a consequence of the band, and the band is a consequence of the evidence. Do not decide the number first.

Bands map to scores exactly: weak 1-3, competent 4-6, strong 7-8, exceptional 9-10.

THE ANTI-7 RULE. A score of 7 or above requires you to name, in the evidence, something this ad does that a merely competent ad in the same category would not. If you cannot name it, the score is 6. Apply this to every axis.

WHERE THE RECORD IS THIN, SAY SO AND SCORE CONSERVATIVELY. If the record's limits field says something was inferred, or a beat is vague, do not treat that gap as evidence in either direction. An ad you cannot assess is a 5 with the reason stated, not a 3 and not an 8.

AXIS 1 - HOOK. Does the opening earn the next three seconds?
weak (1-3): the first beat is a logo, a title card, a slow establishing shot, or a talking head clearing their throat. Nothing is at stake by the second beat.
competent (4-6): a clear subject and a legible claim in the first beat, but the opening could precede any ad in this category.
strong (7-8): the opening creates a specific question or tension a viewer would stay to resolve, and it is particular to this product rather than to its category.
exceptional (9-10): the opening would stop a scroll with the sound off, with no prior knowledge of the brand, and would still read at thumbnail size.

AXIS 2 - UTILITY. Does a viewer who has never heard of this product learn what it does and who it is for?
weak (1-3): after every beat you still could not say what is being sold, or the ad sells a mood with no product in it.
competent (4-6): the product and its category are clear, but the specific problem it solves is inferred rather than shown.
strong (7-8): a named, concrete use is demonstrated, and you can say who this is for and what changes for them.
exceptional (9-10): the demonstration is the argument - the product is shown solving a problem the viewer recognises, with the before and after both legible.
If the record says the pitch is carried by speech that was not audible, say so in the evidence and score what was actually shown, without inventing a voiceover.

AXIS 3 - SUCCINCTNESS. How much of the runtime is doing work?
weak (1-3): beats that repeat each other, a logo sting that outlasts the claim, or a pace that would lose a viewer well before the end.
competent (4-6): mostly purposeful, with one or two beats that could be cut with nothing lost.
strong (7-8): every beat advances the argument, and the ad ends when it is finished rather than when the slot does.
exceptional (9-10): no beat could be removed without losing something load-bearing, and the call to action arrives exactly when the case has been made.

AXIS 4 - PRODUCTION QUALITY. Observable craft only, as recorded.
Judge: exposure, focus, stabilisation, framing, text legibility at thumbnail size, aspect-ratio fit for a feed, colour consistency between shots, and edit hygiene.
Explicitly do not judge: budget, how much you like the product, the taste of the styling, or whether the format is polished versus deliberately rough. A well-shot phone video outscores a badly-lit studio one.
weak (1-3): the record describes unreadable text, blown or crushed exposure, unstable handheld, a wrong aspect ratio, or cuts that jar for no reason.
competent (4-6): clean and competent throughout, nothing distracting, nothing notable.
strong (7-8): deliberate framing and lighting that serve the claim, text sized and placed for a feed, consistent grade across shots.
exceptional (9-10): the craft is itself an argument for the product, and any frame would hold up as a still.
This axis is judged from a description rather than from the footage. Where the record is silent on a detail, do not assume it was fine and do not assume it was bad - stay in the competent band and name the detail that was missing.

Evidence must quote or closely paraphrase the record, run to at most one sentence, and be specific to this ad rather than a restatement of the rubric.`;
