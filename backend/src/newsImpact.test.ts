import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  classifySentence,
  isDistinctiveName,
  isTitleWorthyName,
  isWholeItemMention,
  IS_CHANGELOG,
  sentenceAround,
  titleMentionsItem,
} from "./newsImpact.js";

// Every case below is a real sentence from OSRS patch notes, or the shape of one.
//
// These exist because this module is not algorithmic -- it is a pile of keyword rules tuned by
// running them over six weeks of real changelogs and reading what came back. A rule that looks
// obviously right in isolation is exactly the kind that turns out to invert on real prose, and
// each "should NOT call a direction" case below is a bug that was actually shipped and caught:
// the first version of the classifier got the direction wrong more often than right, and the
// tests are the record of how.
//
// The asymmetry is deliberate. A missed nerf costs a reader one glance at the news. A false nerf
// costs them trust in the whole panel, and a panel nobody believes is worse than no panel.

describe("classifySentence", () => {
  it("calls a nerf when the notes say nerf", () => {
    const got = classifySentence("We've nerfed the Twisted bow's accuracy against low defence.");
    assert.equal(got.impact, "nerf");
  });

  it("calls a buff when the notes say buff", () => {
    const got = classifySentence("The Dragon warhammer special attack has been buffed.");
    assert.equal(got.impact, "buff");
  });

  it("reads a more generous drop rate as a nerf, because supply is what moves the price", () => {
    // The player-vs-flipper inversion, and the single most important case here: this sentence is
    // good news in-game and bad news for anyone holding the item.
    const got = classifySentence(
      "Increased the drop rate of the Abyssal whip from Abyssal demons.",
    );
    assert.equal(got.impact, "nerf");
  });

  it("reads a stingier drop rate as a buff", () => {
    const got = classifySentence("We have reduced the drop rate of the Elder maul.");
    assert.equal(got.impact, "buff");
  });

  it("reads increased rarity as a buff", () => {
    const got = classifySentence("The Twisted bow is now rarer from the Chambers of Xeric.");
    assert.equal(got.impact, "buff");
  });

  it("stays quiet when a drop change cuts both ways", () => {
    const got = classifySentence(
      "We reduced the drop rate from Vorkath but added a second source, so it drops more often overall.",
    );
    assert.equal(got.impact, "unclear");
  });

  // The four regressions. Each of these was called confidently, and wrongly, by the first version.
  it("does not read a REMOVED REQUIREMENT as a nerf", () => {
    // Shipped as a nerf on the word "removed". Removing a requirement widens the buyer pool, so
    // if it means anything it means the opposite.
    const got = classifySentence(
      "The hitpoints requirement for equipping a Nightmare Staff has been removed.",
    );
    assert.equal(got.impact, "unclear");
  });

  it("does not read a COSMETIC fix as a nerf", () => {
    // Shipped as two separate nerfs, one for each scimitar named in a sprite fix.
    const got = classifySentence(
      "The Bronze scimitar crate on Ape Atoll no longer shows a picture of an Iron scimitar.",
    );
    assert.equal(got.impact, "unclear");
  });

  it("does not read a RIVAL item being better as a buff for this one", () => {
    // Shipped as a buff for the necklace on the word "increase", when the sentence is about
    // something else outclassing it.
    const got = classifySentence(
      "These amulets serving as a slight increase over the Occult Necklace was a welcome change.",
    );
    assert.equal(got.impact, "unclear");
  });

  it("does not read a LIMITATION as a buff", () => {
    // Shipped as a buff on "boost", in a sentence saying the boost does not apply.
    const got = classifySentence(
      "Rune-boosting effects will not boost extra runes gained from Blood essence.",
    );
    assert.equal(got.impact, "unclear");
  });

  it("reports an ordinary mention without guessing", () => {
    const got = classifySentence("Watermelon crops in farming patches.");
    assert.equal(got.impact, "unclear");
  });
});

describe("isDistinctiveName", () => {
  it("accepts compound names", () => {
    assert.equal(isDistinctiveName("Twisted bow"), true);
    assert.equal(isDistinctiveName("Iron bar"), true);
  });

  it("rejects short single words that collide with ordinary English", () => {
    // The reason this filter exists: these fire on every fishing or woodcutting tweak.
    for (const name of ["Shark", "Bones", "Coal", "Rope", "Feather"]) {
      assert.equal(isDistinctiveName(name), false, `${name} should be rejected`);
    }
  });

  it("accepts long single words", () => {
    assert.equal(isDistinctiveName("Dragonfruit"), true);
  });
});

describe("isWholeItemMention", () => {
  const catalogue = new Set(["rune essence", "dragon bolts", "dragon bolts (e)"]);

  function check(body: string, name: string) {
    const idx = body.toLowerCase().indexOf(name.toLowerCase());
    assert.notEqual(idx, -1, "test setup: name must appear in body");
    return isWholeItemMention(body, idx, name.length, name, catalogue);
  }

  it("rejects a match swallowed by a container name", () => {
    // The real false positive, and the only directional call the first full scan produced: the
    // pouch is not a tradeable item, so the catalogue alone cannot rule it out.
    assert.equal(
      check("Increased the drop rate of the Rune Essence Pouch.", "Rune essence"),
      false,
    );
  });

  it("rejects a match swallowed by a longer catalogue name", () => {
    assert.equal(check("We have changed Dragon bolts (e) this week.", "Dragon bolts"), false);
  });

  it("accepts a genuine standalone mention", () => {
    assert.equal(check("The Rune essence market has been quiet.", "Rune essence"), true);
  });
});

describe("titleMentionsItem", () => {
  const catalogue = new Set(["coal", "rune essence", "snape grass", "dragon bolts (e)"]);

  it("matches a short name a changelog scan would have to reject", () => {
    // The reason titles get their own, looser rule. "Coal" is four characters and would collide
    // constantly inside a 28,000-character article, but a post title is a topic label: this one
    // is ABOUT coal, and it is exactly the kind of thing a coal holder wants to see.
    assert.equal(titleMentionsItem("Coal near all time lows", "Coal", catalogue), true);
  });

  it("splits a title naming several items", () => {
    // Real post: one headline, three separate positions to think about.
    const title = "Sapphire, emerald and ruby low";
    assert.equal(titleMentionsItem(title, "Emerald", catalogue), true);
    assert.equal(titleMentionsItem(title, "Ruby", catalogue), true);
  });

  it("is case-insensitive, because nobody capitalises correctly on Reddit", () => {
    assert.equal(titleMentionsItem("Tormented Synapse and Raids 4", "Tormented synapse", catalogue), true);
  });

  it("still refuses a name swallowed by a longer one", () => {
    // The title rules are looser about length, not about correctness.
    assert.equal(titleMentionsItem("Rune Essence Pouch prices?", "Rune essence", catalogue), false);
  });

  it("rejects names below the floor", () => {
    assert.equal(titleMentionsItem("Got a new pet today", "Pet", catalogue), false);
  });

  it("does not match a name that is not there", () => {
    assert.equal(titleMentionsItem("Coal near all time lows", "Snape grass", catalogue), false);
  });
});

describe("isTitleWorthyName", () => {
  it("keeps the short staple names the changelog rule drops", () => {
    // isDistinctiveName rejects all of these, deliberately, and the title rule must not.
    for (const name of ["Coal", "Bones", "Rope"]) {
      assert.equal(isTitleWorthyName(name), true, `${name} should pass the title floor`);
      assert.equal(isDistinctiveName(name), false, `${name} should fail the article floor`);
    }
  });

  it("still rejects very short names", () => {
    assert.equal(isTitleWorthyName("Pot"), false);
  });
});

describe("sentenceAround", () => {
  it("returns only the sentence the match sits in", () => {
    const body = "An unrelated change. The Twisted bow was adjusted. Another unrelated change.";
    const idx = body.indexOf("Twisted bow");
    const quote = sentenceAround(body, idx, "Twisted bow".length);
    assert.equal(quote, "The Twisted bow was adjusted.");
  });

  it("stays bounded when the changelog has no sentence breaks", () => {
    // Patch notes that lose their bullet structure become one enormous run-on, and an unbounded
    // slice would quote the whole update as evidence for one item.
    const body = `${"x".repeat(2000)} Twisted bow ${"y".repeat(2000)}`;
    const idx = body.indexOf("Twisted bow");
    const quote = sentenceAround(body, idx, "Twisted bow".length);
    assert.ok(quote.length < 1000, `quote was ${quote.length} chars`);
  });
});

describe("IS_CHANGELOG", () => {
  it("accepts articles carrying a changelog", () => {
    assert.equal(IS_CHANGELOG.test("Changelog - September 16th"), true);
    assert.equal(IS_CHANGELOG.test("Here are this week's patch notes."), true);
  });

  it("rejects the newsroom posts that produced the interview noise", () => {
    // "I realized I lost my tinderbox so I started a new account" came from one of these.
    assert.equal(IS_CHANGELOG.test("Community Spotlight: get to know the team!"), false);
    assert.equal(IS_CHANGELOG.test("The Official OSRS Podcast Episode 20"), false);
  });
});
