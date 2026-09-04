import type { Block, ParsedDocument } from '../document/nodes';
import { projectRun } from '../selection/mapSelection';
import type {
  PreviousProjection,
  ProjectedRun,
  ProjectRunOptions,
} from '../selection/mapSelection';
import type { EmbedLookup, RunSegment } from '../selection/runs';

/**
 * The memo that makes a growing settled run cost its growth.
 *
 * THE PROBLEM IT SOLVES. `segmentRuns` merges every adjacent settled flowing
 * block into one run, so an ordinary chat answer is ONE run that gets one block
 * longer on every settle. Its span and block list change each time, so the
 * per-run memo in `SelectableMarkdown` misses, `projectRun` re-walks the whole
 * accumulated run, and `resolveRunAttributes`/`resolveRunDecorations` rebuild
 * from the new projection. That is O(document) view work per settle and
 * O(document²) over a stream: measured at 668,995 characters projected for a
 * 14 kB document and 2,528,198 for a 28 kB one — doubling the document
 * quadrupled the work, with one late settle re-projecting a 25 kB run.
 *
 * WHAT IT DOES. It remembers the last projection this run produced and hands it
 * to `projectRun` as `previous`, which extends it with only the blocks appended
 * since (see `PreviousProjection`). Growth costs the growth; a re-segmentation
 * that changed nothing costs nothing at all, because `projectRun` hands the
 * SAME projection object back and every memo downstream keys on its identity.
 *
 * ONE ENTRY, NOT A MAP. A cache belongs to one run — `SelectableMarkdown` holds
 * one per `RunView` instance, whose React key (`runKey`) is stable across the
 * settles that grow it — so the useful history is exactly one projection deep,
 * and the entry dies with the component rather than needing eviction.
 *
 * IT KEYS ON EVERYTHING THE PROJECTION DEPENDS ON, which is why `projectRun`'s
 * own `previous` option can stay a bare pair of values: the marker glyphs and
 * the embed lookup both change the projected text, and the blocks are checked
 * for prefix identity inside `projectRun`. A miss on any of them is a full
 * reprojection, never a splice of two different projections.
 *
 * Kept out of `SelectableMarkdown.tsx` for the same reason `runIdentity.ts` is:
 * that module imports react-native at module scope, and this logic is worth
 * testing in plain Node.
 */
export interface RunProjectionCache {
  /**
   * `projectRun(run, doc, options)`, incrementally when this cache holds a
   * projection of a prefix of `run` under the same options.
   */
  project(
    run: RunSegment,
    doc: ParsedDocument,
    options?: ProjectRunOptions,
  ): ProjectedRun;
}

/** What one cache remembers: the projection, and the key it was built under. */
interface Entry {
  blocks: readonly Block[];
  projected: ProjectedRun;
  bullet: string | undefined;
  taskChecked: string | undefined;
  taskUnchecked: string | undefined;
  embed: EmbedLookup | undefined;
}

export function createRunProjectionCache(): RunProjectionCache {
  let entry: Entry | null = null;

  return {
    project(run, doc, options) {
      const glyphs = options?.glyphs;
      const bullet = glyphs?.bullet;
      const taskChecked = glyphs?.taskChecked;
      const taskUnchecked = glyphs?.taskUnchecked;
      const embed = options?.embed;
      // The glyph VALUES, not the object they arrived in: `SelectableMarkdown`
      // rebuilds that object every render from the theme, and a value-equal
      // rebuild must not throw the projection away.
      let previous: PreviousProjection | undefined;
      if (
        entry !== null &&
        entry.bullet === bullet &&
        entry.taskChecked === taskChecked &&
        entry.taskUnchecked === taskUnchecked &&
        entry.embed === embed
      ) {
        previous = { blocks: entry.blocks, projected: entry.projected };
      }
      const projected = projectRun(run, doc, { glyphs, embed, previous });
      entry = {
        blocks: run.blocks,
        projected,
        bullet,
        taskChecked,
        taskUnchecked,
        embed,
      };
      return projected;
    },
  };
}
