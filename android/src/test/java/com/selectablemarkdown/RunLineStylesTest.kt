package com.selectablemarkdown

import org.junit.Assert.assertEquals
import org.junit.Test

class RunLineStylesTest {
    @Test fun colorOnlyOverrideRecolorsTheInheritedLineWithoutDrawingItTwice() {
        val styles = RunLineStyles(12)
        styles.apply(0, 12, "underline", "dashed", 1)
        styles.apply(3, 7, null, null, 2)
        assertEquals(listOf(
            RunLineStyles.Range(0, 3, "underline", "dashed", 1),
            RunLineStyles.Range(3, 7, "underline", "dashed", 2),
            RunLineStyles.Range(7, 12, "underline", "dashed", 1),
        ), styles.ranges())
    }

    @Test fun styleOnlyOverrideRestylesExistingLinesWithoutAddingLinesInTheGaps() {
        val styles = RunLineStyles(12)
        styles.apply(0, 3, "underline", null, null)
        styles.apply(6, 9, "line-through", null, null)
        styles.apply(1, 8, null, "dotted", null)
        assertEquals(listOf(
            RunLineStyles.Range(0, 1, "underline", null, null),
            RunLineStyles.Range(1, 3, "underline", "dotted", null),
            RunLineStyles.Range(6, 8, "line-through", "dotted", null),
            RunLineStyles.Range(8, 9, "line-through", null, null),
        ), styles.ranges())
    }

    @Test fun noneRemovesAnEnclosingLineOnlyWithinItsRange() {
        val styles = RunLineStyles(10)
        styles.apply(0, 10, "underline", "double", 1)
        styles.apply(2, 8, "none", null, null)
        styles.apply(4, 6, "line-through", null, null)
        assertEquals(listOf(
            RunLineStyles.Range(0, 2, "underline", "double", 1),
            RunLineStyles.Range(4, 6, "line-through", null, 1),
            RunLineStyles.Range(8, 10, "underline", "double", 1),
        ), styles.ranges())
    }

    @Test fun solidResetsAnInheritedPattern() {
        val styles = RunLineStyles(8)
        styles.apply(0, 8, "underline", "dashed", 1)
        styles.apply(0, 8, null, "solid", null)
        assertEquals(listOf(RunLineStyles.Range(0, 8, "underline", "solid", 1)), styles.ranges())
    }

    @Test fun anExplicitLineReplacesTheOuterLineAndResetsItsPattern() {
        val styles = RunLineStyles(8)
        styles.apply(0, 8, "line-through", "dotted", 1)
        styles.apply(0, 8, "underline", null, null)
        assertEquals(listOf(RunLineStyles.Range(0, 8, "underline", null, 1)), styles.ranges())
    }

    @Test fun colorCanBeInheritedFromARangeWithNoLine() {
        val styles = RunLineStyles(8)
        styles.apply(0, 8, null, "dashed", 1)
        assertEquals(emptyList<RunLineStyles.Range>(), styles.ranges())
        styles.apply(2, 6, "underline", null, null)
        assertEquals(listOf(RunLineStyles.Range(2, 6, "underline", null, 1)), styles.ranges())
    }

    @Test fun equalAdjacentRangesMergeAndDoNotLeakIntoSiblings() {
        val styles = RunLineStyles(12)
        styles.apply(0, 4, "underline", null, 1)
        styles.apply(4, 8, "underline", null, 1)
        styles.apply(8, 12, "underline", null, null)
        assertEquals(listOf(
            RunLineStyles.Range(0, 8, "underline", null, 1),
            RunLineStyles.Range(8, 12, "underline", null, null),
        ), styles.ranges())
    }
}
