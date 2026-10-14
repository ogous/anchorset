# The rating files

How to write the file `agree` reads to compare graders, and the two files `drift` reads to check a judge over
time.

A **grader** is whoever gives the label, a person or a model; the reports say "rater". A **judge** is a grader
that is a model. The **packet** is what a grader was shown for one item. A packet hash is any sha256 of it that
you always make the same way. One way: save what the graders were shown for the item as one file, and run
`shasum -a 256 <file>` on it. The first 64 characters it prints are the hash. Graders who were shown the same
file get the same hash.

Run the commands from the root of a clone of this repository.

## The ratings file (`agree`)

One file holds the labels of two or more graders on the same items. This is
[`examples/refund-bot/ratings.json`](../examples/refund-bot/ratings.json); `…` marks what is left out.

```json
{
  "schema": "anchorset.ratings/v1",
  "categories": ["none", "review", "handoff"],
  "ratings": {
    "rater-a": { "t01": "none", "t02": "none", "t03": "none", "t04": "handoff", … },
    "rater-b": { "t01": "none", "t02": "none", "t03": "review", "t04": "handoff", … },
    "rater-c": { "t01": "none", "t02": "none", "t03": "none", "t04": "handoff", … }
  },
  "packetHashes": {
    "rater-a": { "t01": "9b08a5e359395cf2f4f1d5202b3c6c80751dfac8be6850b5394932ac0a961c2e", … },
    "rater-b": { "t01": "9b08a5e359395cf2f4f1d5202b3c6c80751dfac8be6850b5394932ac0a961c2e", … },
    "rater-c": { "t01": "9b08a5e359395cf2f4f1d5202b3c6c80751dfac8be6850b5394932ac0a961c2e", … }
  },
  "bootstrap": { "iterations": 2000, "seed": 7, "alpha": 0.05 }
}
```

| Field | What it means |
|---|---|
| `schema` | Always `"anchorset.ratings/v1"` |
| `categories` | Every label of your scale, including one no grader used |
| `ratings` | For each grader, the label of each item. At least two graders, and all of them label the same items |
| `packetHashes` | For each grader, the packet hash of each item. On one item, every grader has the same hash |
| `bootstrap` | Optional. How the brackets are computed. Left out: 2000 resamples, seed 0, and alpha 0.05 for 95% brackets |

```bash
node src/cli.ts agree --ratings examples/refund-bot/ratings.json
```

## The anchor files (`drift`)

Two files: the same items, graded by the same judge, earlier and later. This is
[`examples/refund-bot/anchor_old.json`](../examples/refund-bot/anchor_old.json);
[`anchor_new.json`](../examples/refund-bot/anchor_new.json) has the same form.

```json
{
  "schema": "anchorset.anchor/v1",
  "labels": ["none", "review", "handoff"],
  "verdicts": { "a01": "none", "a02": "none", …, "a24": "handoff" },
  "packetHashes": {
    "a01": "e3baf9fec6e1e3d4de75328d969935c2eba5d49f4770389ecabb9108dcd40375",
    "a02": "95c7ab11675c350f42d265ba7ab8f246f4128377cc5c4e73369f049c1fbaccaa",
    …
  }
}
```

| Field | What it means |
|---|---|
| `schema` | Always `"anchorset.anchor/v1"` |
| `labels` | Every label of your scale, including one the judge did not use. The same list in both files |
| `verdicts` | The label of each item. The same items in both files |
| `packetHashes` | The packet hash of each item. The same hash in both files |

```bash
node src/cli.ts drift --old examples/refund-bot/anchor_old.json --new examples/refund-bot/anchor_new.json --flag handoff
```

`--flag` is required. It names the labels you watch most, separated by commas; each must be in `labels`. The
report counts the items with a flagged label in each reading, and how far the two sets of items overlap.

The anchor files have no `bootstrap` key. The brackets of `drift` use 2000 resamples, and `--bootstrap-seed
<number>` sets their seed (0 if left out).

## Reading the numbers

**Kappa and AC1** are agreement beyond luck: 1 is full agreement, 0 is what luck alone would give, and below 0
is less agreement than luck. They count luck differently. When one label is much more common than the others,
kappa drops even if the graders mostly agree, and AC1 drops less. So both are printed, with `prevalence`, the
share of each label.

**`agreement`** is the share of items on which two graders gave the same label. With three or more graders the
line reads `mean pairwise agreement`: that share, averaged over every pair. It is not the share of items on
which all of them agree.

**The brackets** after kappa and AC1 (the report also calls them an interval) show how much the number moves when
the items are drawn again from your own items. They cover the choice of items only: the same judge, asked again,
can land outside them. Whether they hold the true value 95% of the time has not been checked.

**The transition table** of `drift` has a row for each old label and a column for each new one. In the example,
three items went from `review` to `handoff`.

**The `classification` line** of `drift` uses two fixed numbers:

- `item-shift`: fewer than 0.8 of the flagged items are shared, counted against the smaller of the two sets.
- `threshold-shift`: otherwise, some label's count moved by 0.05 of the items or more.
- `counts-stable`: otherwise.

`counts-stable` does not mean that nothing moved: items can swap labels and leave every count the same, and a count
can move by less than the threshold. So the line also says how many items changed label. And a judge that has not changed also gives different labels from one reading
to the next; the rule cannot tell that from a change.

## If the tool refuses your file

A file that breaks the format gives `anchorset: invalid input` and exit code 65. A comparison the tool will not
make gives `REFUSED` and exit code 2.

- `PACKET_MISMATCH` → on the items named, a packet hash is missing, is not a full sha256, or differs between the
  graders or the two readings. If it names `old.packetHashes` or `new.packetHashes`, that file has none.
- `is given twice` → a grader or an item is named twice. Keep one.
- `unknown field` → a key is not in the tables above. The files have no place for notes or for the judge's name.
- `is not a declared category` or `is not in […]` → a label, or a `--flag` value, is not in `categories` or
  `labels`.
- `ITEM_SET_MISMATCH` or `LABELS_MISMATCH` → the graders, or the two anchor files, do not hold the same items
  or the same list of labels.

## Limits

- The files do not name the judge. Keeping it the same in both anchor files is up to you.
- The packet hashes are what your files state. The tool cannot check what a grader really saw.
