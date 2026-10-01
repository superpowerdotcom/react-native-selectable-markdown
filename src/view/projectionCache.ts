import type { Block, ParsedDocument } from '../document/nodes';
import { projectRun } from '../selection/mapSelection';
import type {
  PreviousProjection,
  ProjectedRun,
  ProjectRunOptions,
} from '../selection/mapSelection';
import type { EmbedLookup, RunSegment } from '../selection/runs';

/**
 * Projects a growing run by extending its last projection with the appended
 * blocks. Hold one per run; a change of glyphs or `embed` reprojects in full.
 */
export interface RunProjectionCache {
  project(
    run: RunSegment,
    doc: ParsedDocument,
    options?: ProjectRunOptions,
  ): ProjectedRun;
}

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
      // Glyph values, not their object: `SelectableMarkdown` rebuilds it every render.
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
