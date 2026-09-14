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
 * The bands are the actual mechanism. Opus 5 rejects temperature, top_p and
 * top_k outright, so there is no sampling knob to turn down for stability: the
 * only lever left is making the scale concrete enough that two runs land in the
 * same band. The anti-7 rule is what stops everything drifting to mid-scale.
 */

export const RUBRIC_VERSION = "rubric_v1";

export const RUBRIC = `You are scoring a single video advertisement from the Meta Ad Library. You are given still frames sampled from it, front-weighted toward the opening, plus the ad's own copy.

Score four axes out of 10. For each axis, in this order: quote the evidence, name the frame it came from, choose a band, then give the number. The number is a consequence of the band, and the band is a consequence of the evidence. Do not decide the number first.

Bands map to scores exactly: weak 1-3, competent 4-6, strong 7-8, exceptional 9-10.

THE ANTI-7 RULE. A score of 7 or above requires you to name, in the evidence, something this ad does that a merely competent ad in the same category would not. If you cannot name it, the score is 6. Apply this to every axis.

AXIS 1 - HOOK. Does the opening earn the next three seconds?
weak (1-3): the first second is a logo, a title card, a slow establishing shot, or a talking head clearing their throat. Nothing is at stake by the second frame.
competent (4-6): a clear subject and a legible claim inside the first second, but the opening could precede any ad in this category.
strong (7-8): the opening frame creates a specific question or tension a viewer would stay to resolve, and it is particular to this product rather than to its category.
exceptional (9-10): the opening would stop a scroll with the sound off, with no prior knowledge of the brand, and would still be legible at thumbnail size.

AXIS 2 - UTILITY. Does a viewer who has never heard of this product learn what it does and who it is for?
weak (1-3): after every frame you still cannot say what is being sold, or the ad sells a mood with no product in it.
competent (4-6): the product and its category are clear, but the specific problem it solves is inferred rather than shown.
strong (7-8): a named, concrete use is demonstrated on screen, and you can say who this is for and what changes for them.
exceptional (9-10): the demonstration itself is the argument - the product is shown solving a problem the viewer recognises, with the before and after both legible.
Judge this from the frames and the ad copy together. If the pitch is plainly carried by speech you cannot hear, say so in the evidence and score what is actually shown, without inventing a voiceover.

AXIS 3 - SUCCINCTNESS. How much of the runtime is doing work?
weak (1-3): long stretches of filler, repeated beats, a logo sting that outlasts the claim, or a pace that would lose a viewer well before the end.
competent (4-6): mostly purposeful, with one or two passages that could be cut with nothing lost.
strong (7-8): every sampled frame advances the argument, and the ad ends when it is finished rather than when the slot does.
exceptional (9-10): the ad could not be shortened without removing a load-bearing beat, and the call to action arrives exactly when the case has been made.

AXIS 4 - PRODUCTION QUALITY. Observable craft only.
Judge: exposure, focus, stabilisation, framing, text legibility at thumbnail size, aspect-ratio fit for a feed, colour consistency between shots, and edit hygiene.
Explicitly do not judge: budget, how much you like the product, the taste of the styling, or whether the format is polished versus deliberately rough. A well-shot phone video outscores a badly-lit studio one.
weak (1-3): unreadable text, blown or crushed exposure, unstable handheld, wrong aspect ratio with letterboxing, or cuts that jar for no reason.
competent (4-6): clean and competent throughout, nothing distracting, nothing notable.
strong (7-8): deliberate framing and lighting that serve the claim, text sized and placed for a feed, consistent grade across shots.
exceptional (9-10): the craft is itself an argument for the product, and every frame would hold up as a still.

Evidence must be specific to what you can see, at most one sentence, and must cite what is in the frame rather than restate the rubric. If the frames are too few or too degraded to judge an axis, say so in the evidence and score conservatively rather than guessing.`;
