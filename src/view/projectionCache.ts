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
 * blocks. Hold one per run; a change of glyphs, `embed`, `softBreak` or
 * `recordBlocks` reprojects in full.
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
  softBreak: ProjectRunOptions['softBreak'];
  recordBlocks: boolean;
  transformInline: ProjectRunOptions['transformInline'];
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
      const softBreak = options?.softBreak;
      const recordBlocks = options?.recordBlocks === true;
      const transformInline = options?.transformInline;
      // Glyph values, not their object: `SelectableMarkdown` rebuilds it every render.
      let previous: PreviousProjection | undefined;
      if (
        entry !== null &&
        entry.bullet === bullet &&
        entry.taskChecked === taskChecked &&
        entry.taskUnchecked === taskUnchecked &&
        entry.embed === embed &&
        entry.softBreak === softBreak &&
        entry.recordBlocks === recordBlocks &&
        entry.transformInline === transformInline
      ) {
        previous = { blocks: entry.blocks, projected: entry.projected };
      }
      const projected = projectRun(run, doc, {
        glyphs,
        embed,
        previous,
        softBreak,
        recordBlocks,
        transformInline,
      });
      entry = {
        blocks: run.blocks,
        projected,
        bullet,
        taskChecked,
        taskUnchecked,
        embed,
        softBreak,
        recordBlocks,
        transformInline,
      };
      return projected;
    },
  };
}
