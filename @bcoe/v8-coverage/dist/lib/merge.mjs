import { deepNormalizeScriptCov, normalizeFunctionCov, normalizeProcessCov, normalizeRangeTree, normalizeScriptCov, } from "./normalize";
import { RangeTree } from "./range-tree";
/**
 * Merges a list of process coverages.
 *
 * The result is normalized.
 * The input values may be mutated, it is not safe to use them after passing
 * them to this function.
 * The computation is synchronous.
 *
 * @param processCovs Process coverages to merge.
 * @return Merged process coverage.
 */
export function mergeProcessCovs(processCovs) {
    if (processCovs.length === 0) {
        return { result: [] };
    }
    const urlToScripts = new Map();
    for (const processCov of processCovs) {
        for (const scriptCov of processCov.result) {
            let scriptCovs = urlToScripts.get(scriptCov.url);
            if (scriptCovs === undefined) {
                scriptCovs = [];
                urlToScripts.set(scriptCov.url, scriptCovs);
            }
            scriptCovs.push(scriptCov);
        }
    }
    const result = [];
    for (const scripts of urlToScripts.values()) {
        // assert: `scripts.length > 0`
        result.push(mergeScriptCovs(scripts));
    }
    const merged = { result };
    normalizeProcessCov(merged);
    return merged;
}
/**
 * Merges a list of matching script coverages.
 *
 * Scripts are matching if they have the same `url`.
 * The result is normalized.
 * The input values may be mutated, it is not safe to use them after passing
 * them to this function.
 * The computation is synchronous.
 *
 * @param scriptCovs Process coverages to merge.
 * @return Merged script coverage, or `undefined` if the input list was empty.
 */
export function mergeScriptCovs(scriptCovs) {
    if (scriptCovs.length === 0) {
        return undefined;
    }
    else if (scriptCovs.length === 1) {
        const merged = scriptCovs[0];
        deepNormalizeScriptCov(merged);
        return merged;
    }
    const first = scriptCovs[0];
    const scriptId = first.scriptId;
    const url = first.url;
    const rangeToFuncs = new Map();
    for (const scriptCov of scriptCovs) {
        for (const funcCov of scriptCov.functions) {
            const rootRange = stringifyFunctionRootRange(funcCov);
            let funcCovs = rangeToFuncs.get(rootRange);
            if (funcCovs === undefined ||
                // if the entry in rangeToFuncs is function-level granularity and
                // the new coverage is block-level, prefer block-level.
                (!funcCovs[0].isBlockCoverage && funcCov.isBlockCoverage)) {
                funcCovs = [];
                rangeToFuncs.set(rootRange, funcCovs);
            }
            else if (funcCovs[0].isBlockCoverage && !funcCov.isBlockCoverage) {
                // if the entry in rangeToFuncs is block-level granularity, we should
                // not append function level granularity.
                continue;
            }
            funcCovs.push(funcCov);
        }
    }
    const functions = [];
    for (const funcCovs of rangeToFuncs.values()) {
        // assert: `funcCovs.length > 0`
        functions.push(mergeFunctionCovs(funcCovs));
    }
    const merged = { scriptId, url, functions };
    normalizeScriptCov(merged);
    return merged;
}
/**
 * Returns a string representation of the root range of the function.
 *
 * This string can be used to match function with same root range.
 * The string is derived from the start and end offsets of the root range of
 * the function.
 * This assumes that `ranges` is non-empty (true for valid function coverages).
 *
 * @param funcCov Function coverage with the range to stringify
 * @internal
 */
function stringifyFunctionRootRange(funcCov) {
    const rootRange = funcCov.ranges[0];
    return `${rootRange.startOffset.toString(10)};${rootRange.endOffset.toString(10)}`;
}
/**
 * Merges a list of matching function coverages.
 *
 * Functions are matching if their root ranges have the same span.
 * The result is normalized.
 * The input values may be mutated, it is not safe to use them after passing
 * them to this function.
 * The computation is synchronous.
 *
 * @param funcCovs Function coverages to merge.
 * @return Merged function coverage, or `undefined` if the input list was empty.
 */
export function mergeFunctionCovs(funcCovs) {
    if (funcCovs.length === 0) {
        return undefined;
    }
    else if (funcCovs.length === 1) {
        const merged = funcCovs[0];
        normalizeFunctionCov(merged);
        return merged;
    }
    const functionName = funcCovs[0].functionName;
    const trees = [];
    for (const funcCov of funcCovs) {
        // assert: `fn.ranges.length > 0`
        // assert: `fn.ranges` is sorted
        trees.push(RangeTree.fromSortedRanges(funcCov.ranges));
    }
    // assert: `trees.length > 0`
    const mergedTree = mergeRangeTrees(trees);
    normalizeRangeTree(mergedTree);
    const ranges = mergedTree.toRanges();
    const isBlockCoverage = !(ranges.length === 1 && ranges[0].count === 0);
    const merged = { functionName, ranges, isBlockCoverage };
    // assert: `merged` is normalized
    return merged;
}
/**
 * @precondition Same `start` and `end` for all the trees
 */
function mergeRangeTrees(trees) {
    if (trees.length <= 1) {
        return trees[0];
    }
    const first = trees[0];
    let delta = 0;
    for (const tree of trees) {
        delta += tree.delta;
    }
    const children = mergeRangeTreeChildren(trees);
    return new RangeTree(first.start, first.end, delta, children);
}
class RangeTreeWithParent {
    constructor(parentIndex, tree) {
        this.parentIndex = parentIndex;
        this.tree = tree;
    }
}
class StartEvent {
    constructor(offset, trees) {
        this.offset = offset;
        this.trees = trees;
    }
    static compare(a, b) {
        return a.offset - b.offset;
    }
}
class StartEventQueue {
    constructor(queue) {
        this.queue = queue;
        this.nextIndex = 0;
        this.pendingOffset = 0;
        this.pendingTrees = undefined;
    }
    static fromParentTrees(parentTrees) {
        const startToTrees = new Map();
        for (const [parentIndex, parentTree] of parentTrees.entries()) {
            for (const child of parentTree.children) {
                let trees = startToTrees.get(child.start);
                if (trees === undefined) {
                    trees = [];
                    startToTrees.set(child.start, trees);
                }
                trees.push(new RangeTreeWithParent(parentIndex, child));
            }
        }
        const queue = [];
        for (const [startOffset, trees] of startToTrees) {
            queue.push(new StartEvent(startOffset, trees));
        }
        queue.sort(StartEvent.compare);
        return new StartEventQueue(queue);
    }
    setPendingOffset(offset) {
        this.pendingOffset = offset;
    }
    pushPendingTree(tree) {
        if (this.pendingTrees === undefined) {
            this.pendingTrees = [];
        }
        this.pendingTrees.push(tree);
    }
    next() {
        const pendingTrees = this.pendingTrees;
        const nextEvent = this.queue[this.nextIndex];
        if (pendingTrees === undefined) {
            this.nextIndex++;
            return nextEvent;
        }
        else if (nextEvent === undefined) {
            this.pendingTrees = undefined;
            return new StartEvent(this.pendingOffset, pendingTrees);
        }
        else {
            if (this.pendingOffset < nextEvent.offset) {
                this.pendingTrees = undefined;
                return new StartEvent(this.pendingOffset, pendingTrees);
            }
            else {
                if (this.pendingOffset === nextEvent.offset) {
                    this.pendingTrees = undefined;
                    for (const tree of pendingTrees) {
                        nextEvent.trees.push(tree);
                    }
                }
                this.nextIndex++;
                return nextEvent;
            }
        }
    }
}
function mergeRangeTreeChildren(parentTrees) {
    const result = [];
    const startEventQueue = StartEventQueue.fromParentTrees(parentTrees);
    const parentToNested = new Map();
    let openRange;
    while (true) {
        const event = startEventQueue.next();
        if (event === undefined) {
            break;
        }
        if (openRange !== undefined && openRange.end <= event.offset) {
            result.push(nextChild(openRange, parentToNested));
            openRange = undefined;
        }
        if (openRange === undefined) {
            let openRangeEnd = event.offset + 1;
            for (const { parentIndex, tree } of event.trees) {
                openRangeEnd = Math.max(openRangeEnd, tree.end);
                insertChild(parentToNested, parentIndex, tree);
            }
            startEventQueue.setPendingOffset(openRangeEnd);
            openRange = { start: event.offset, end: openRangeEnd };
        }
        else {
            for (const { parentIndex, tree } of event.trees) {
                if (tree.end > openRange.end) {
                    const right = tree.split(openRange.end);
                    startEventQueue.pushPendingTree(new RangeTreeWithParent(parentIndex, right));
                }
                insertChild(parentToNested, parentIndex, tree);
            }
        }
    }
    if (openRange !== undefined) {
        result.push(nextChild(openRange, parentToNested));
    }
    return result;
}
function insertChild(parentToNested, parentIndex, tree) {
    let nested = parentToNested.get(parentIndex);
    if (nested === undefined) {
        nested = [];
        parentToNested.set(parentIndex, nested);
    }
    nested.push(tree);
}
function nextChild(openRange, parentToNested) {
    const matchingTrees = [];
    for (const nested of parentToNested.values()) {
        if (nested.length === 1 && nested[0].start === openRange.start && nested[0].end === openRange.end) {
            matchingTrees.push(nested[0]);
        }
        else {
            matchingTrees.push(new RangeTree(openRange.start, openRange.end, 0, nested));
        }
    }
    parentToNested.clear();
    return mergeRangeTrees(matchingTrees);
}

//# sourceMappingURL=data:application/json;charset=utf8;base64,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LENBQUM7U0FDSjtLQUNGO0lBQ0QsY0FBYyxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQ3ZCLE9BQU8sZUFBZSxDQUFDLGFBQWEsQ0FBRSxDQUFDO0FBQ3pDLENBQUMiLCJmaWxlIjoibWVyZ2UuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBkZWVwTm9ybWFsaXplU2NyaXB0Q292LFxuICBub3JtYWxpemVGdW5jdGlvbkNvdixcbiAgbm9ybWFsaXplUHJvY2Vzc0NvdixcbiAgbm9ybWFsaXplUmFuZ2VUcmVlLFxuICBub3JtYWxpemVTY3JpcHRDb3YsXG59IGZyb20gXCIuL25vcm1hbGl6ZVwiO1xuaW1wb3J0IHsgUmFuZ2VUcmVlIH0gZnJvbSBcIi4vcmFuZ2UtdHJlZVwiO1xuaW1wb3J0IHsgRnVuY3Rpb25Db3YsIFByb2Nlc3NDb3YsIFJhbmdlLCBSYW5nZUNvdiwgU2NyaXB0Q292IH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLyoqXG4gKiBNZXJnZXMgYSBsaXN0IG9mIHByb2Nlc3MgY292ZXJhZ2VzLlxuICpcbiAqIFRoZSByZXN1bHQgaXMgbm9ybWFsaXplZC5cbiAqIFRoZSBpbnB1dCB2YWx1ZXMgbWF5IGJlIG11dGF0ZWQsIGl0IGlzIG5vdCBzYWZlIHRvIHVzZSB0aGVtIGFmdGVyIHBhc3NpbmdcbiAqIHRoZW0gdG8gdGhpcyBmdW5jdGlvbi5cbiAqIFRoZSBjb21wdXRhdGlvbiBpcyBzeW5jaHJvbm91cy5cbiAqXG4gKiBAcGFyYW0gcHJvY2Vzc0NvdnMgUHJvY2VzcyBjb3ZlcmFnZXMgdG8gbWVyZ2UuXG4gKiBAcmV0dXJuIE1lcmdlZCBwcm9jZXNzIGNvdmVyYWdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VQcm9jZXNzQ292cyhwcm9jZXNzQ292czogUmVhZG9ubHlBcnJheTxQcm9jZXNzQ292Pik6IFByb2Nlc3NDb3Yge1xuICBpZiAocHJvY2Vzc0NvdnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtyZXN1bHQ6IFtdfTtcbiAgfVxuXG4gIGNvbnN0IHVybFRvU2NyaXB0czogTWFwPHN0cmluZywgU2NyaXB0Q292W10+ID0gbmV3IE1hcCgpO1xuICBmb3IgKGNvbnN0IHByb2Nlc3NDb3Ygb2YgcHJvY2Vzc0NvdnMpIHtcbiAgICBmb3IgKGNvbnN0IHNjcmlwdENvdiBvZiBwcm9jZXNzQ292LnJlc3VsdCkge1xuICAgICAgbGV0IHNjcmlwdENvdnM6IFNjcmlwdENvdltdIHwgdW5kZWZpbmVkID0gdXJsVG9TY3JpcHRzLmdldChzY3JpcHRDb3YudXJsKTtcbiAgICAgIGlmIChzY3JpcHRDb3ZzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgc2NyaXB0Q292cyA9IFtdO1xuICAgICAgICB1cmxUb1NjcmlwdHMuc2V0KHNjcmlwdENvdi51cmwsIHNjcmlwdENvdnMpO1xuICAgICAgfVxuICAgICAgc2NyaXB0Q292cy5wdXNoKHNjcmlwdENvdik7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcmVzdWx0OiBTY3JpcHRDb3ZbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNjcmlwdHMgb2YgdXJsVG9TY3JpcHRzLnZhbHVlcygpKSB7XG4gICAgLy8gYXNzZXJ0OiBgc2NyaXB0cy5sZW5ndGggPiAwYFxuICAgIHJlc3VsdC5wdXNoKG1lcmdlU2NyaXB0Q292cyhzY3JpcHRzKSEpO1xuICB9XG4gIGNvbnN0IG1lcmdlZDogUHJvY2Vzc0NvdiA9IHtyZXN1bHR9O1xuXG4gIG5vcm1hbGl6ZVByb2Nlc3NDb3YobWVyZ2VkKTtcbiAgcmV0dXJuIG1lcmdlZDtcbn1cblxuLyoqXG4gKiBNZXJnZXMgYSBsaXN0IG9mIG1hdGNoaW5nIHNjcmlwdCBjb3ZlcmFnZXMuXG4gKlxuICogU2NyaXB0cyBhcmUgbWF0Y2hpbmcgaWYgdGhleSBoYXZlIHRoZSBzYW1lIGB1cmxgLlxuICogVGhlIHJlc3VsdCBpcyBub3JtYWxpemVkLlxuICogVGhlIGlucHV0IHZhbHVlcyBtYXkgYmUgbXV0YXRlZCwgaXQgaXMgbm90IHNhZmUgdG8gdXNlIHRoZW0gYWZ0ZXIgcGFzc2luZ1xuICogdGhlbSB0byB0aGlzIGZ1bmN0aW9uLlxuICogVGhlIGNvbXB1dGF0aW9uIGlzIHN5bmNocm9ub3VzLlxuICpcbiAqIEBwYXJhbSBzY3JpcHRDb3ZzIFByb2Nlc3MgY292ZXJhZ2VzIHRvIG1lcmdlLlxuICogQHJldHVybiBNZXJnZWQgc2NyaXB0IGNvdmVyYWdlLCBvciBgdW5kZWZpbmVkYCBpZiB0aGUgaW5wdXQgbGlzdCB3YXMgZW1wdHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZVNjcmlwdENvdnMoc2NyaXB0Q292czogUmVhZG9ubHlBcnJheTxTY3JpcHRDb3Y+KTogU2NyaXB0Q292IHwgdW5kZWZpbmVkIHtcbiAgaWYgKHNjcmlwdENvdnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfSBlbHNlIGlmIChzY3JpcHRDb3ZzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IG1lcmdlZDogU2NyaXB0Q292ID0gc2NyaXB0Q292c1swXTtcbiAgICBkZWVwTm9ybWFsaXplU2NyaXB0Q292KG1lcmdlZCk7XG4gICAgcmV0dXJuIG1lcmdlZDtcbiAgfVxuXG4gIGNvbnN0IGZpcnN0OiBTY3JpcHRDb3YgPSBzY3JpcHRDb3ZzWzBdO1xuICBjb25zdCBzY3JpcHRJZDogc3RyaW5nID0gZmlyc3Quc2NyaXB0SWQ7XG4gIGNvbnN0IHVybDogc3RyaW5nID0gZmlyc3QudXJsO1xuXG4gIGNvbnN0IHJhbmdlVG9GdW5jczogTWFwPHN0cmluZywgRnVuY3Rpb25Db3ZbXT4gPSBuZXcgTWFwKCk7XG4gIGZvciAoY29uc3Qgc2NyaXB0Q292IG9mIHNjcmlwdENvdnMpIHtcbiAgICBmb3IgKGNvbnN0IGZ1bmNDb3Ygb2Ygc2NyaXB0Q292LmZ1bmN0aW9ucykge1xuICAgICAgY29uc3Qgcm9vdFJhbmdlOiBzdHJpbmcgPSBzdHJpbmdpZnlGdW5jdGlvblJvb3RSYW5nZShmdW5jQ292KTtcbiAgICAgIGxldCBmdW5jQ292czogRnVuY3Rpb25Db3ZbXSB8IHVuZGVmaW5lZCA9IHJhbmdlVG9GdW5jcy5nZXQocm9vdFJhbmdlKTtcblxuICAgICAgaWYgKGZ1bmNDb3ZzID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgLy8gaWYgdGhlIGVudHJ5IGluIHJhbmdlVG9GdW5jcyBpcyBmdW5jdGlvbi1sZXZlbCBncmFudWxhcml0eSBhbmRcbiAgICAgICAgLy8gdGhlIG5ldyBjb3ZlcmFnZSBpcyBibG9jay1sZXZlbCwgcHJlZmVyIGJsb2NrLWxldmVsLlxuICAgICAgICAoIWZ1bmNDb3ZzWzBdLmlzQmxvY2tDb3ZlcmFnZSAmJiBmdW5jQ292LmlzQmxvY2tDb3ZlcmFnZSkpIHtcbiAgICAgICAgZnVuY0NvdnMgPSBbXTtcbiAgICAgICAgcmFuZ2VUb0Z1bmNzLnNldChyb290UmFuZ2UsIGZ1bmNDb3ZzKTtcbiAgICAgIH0gZWxzZSBpZiAoZnVuY0NvdnNbMF0uaXNCbG9ja0NvdmVyYWdlICYmICFmdW5jQ292LmlzQmxvY2tDb3ZlcmFnZSkge1xuICAgICAgICAvLyBpZiB0aGUgZW50cnkgaW4gcmFuZ2VUb0Z1bmNzIGlzIGJsb2NrLWxldmVsIGdyYW51bGFyaXR5LCB3ZSBzaG91bGRcbiAgICAgICAgLy8gbm90IGFwcGVuZCBmdW5jdGlvbiBsZXZlbCBncmFudWxhcml0eS5cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmdW5jQ292cy5wdXNoKGZ1bmNDb3YpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGZ1bmN0aW9uczogRnVuY3Rpb25Db3ZbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGZ1bmNDb3ZzIG9mIHJhbmdlVG9GdW5jcy52YWx1ZXMoKSkge1xuICAgIC8vIGFzc2VydDogYGZ1bmNDb3ZzLmxlbmd0aCA+IDBgXG4gICAgZnVuY3Rpb25zLnB1c2gobWVyZ2VGdW5jdGlvbkNvdnMoZnVuY0NvdnMpISk7XG4gIH1cblxuICBjb25zdCBtZXJnZWQ6IFNjcmlwdENvdiA9IHtzY3JpcHRJZCwgdXJsLCBmdW5jdGlvbnN9O1xuICBub3JtYWxpemVTY3JpcHRDb3YobWVyZ2VkKTtcbiAgcmV0dXJuIG1lcmdlZDtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIGEgc3RyaW5nIHJlcHJlc2VudGF0aW9uIG9mIHRoZSByb290IHJhbmdlIG9mIHRoZSBmdW5jdGlvbi5cbiAqXG4gKiBUaGlzIHN0cmluZyBjYW4gYmUgdXNlZCB0byBtYXRjaCBmdW5jdGlvbiB3aXRoIHNhbWUgcm9vdCByYW5nZS5cbiAqIFRoZSBzdHJpbmcgaXMgZGVyaXZlZCBmcm9tIHRoZSBzdGFydCBhbmQgZW5kIG9mZnNldHMgb2YgdGhlIHJvb3QgcmFuZ2Ugb2ZcbiAqIHRoZSBmdW5jdGlvbi5cbiAqIFRoaXMgYXNzdW1lcyB0aGF0IGByYW5nZXNgIGlzIG5vbi1lbXB0eSAodHJ1ZSBmb3IgdmFsaWQgZnVuY3Rpb24gY292ZXJhZ2VzKS5cbiAqXG4gKiBAcGFyYW0gZnVuY0NvdiBGdW5jdGlvbiBjb3ZlcmFnZSB3aXRoIHRoZSByYW5nZSB0byBzdHJpbmdpZnlcbiAqIEBpbnRlcm5hbFxuICovXG5mdW5jdGlvbiBzdHJpbmdpZnlGdW5jdGlvblJvb3RSYW5nZShmdW5jQ292OiBSZWFkb25seTxGdW5jdGlvbkNvdj4pOiBzdHJpbmcge1xuICBjb25zdCByb290UmFuZ2U6IFJhbmdlQ292ID0gZnVuY0Nvdi5yYW5nZXNbMF07XG4gIHJldHVybiBgJHtyb290UmFuZ2Uuc3RhcnRPZmZzZXQudG9TdHJpbmcoMTApfTske3Jvb3RSYW5nZS5lbmRPZmZzZXQudG9TdHJpbmcoMTApfWA7XG59XG5cbi8qKlxuICogTWVyZ2VzIGEgbGlzdCBvZiBtYXRjaGluZyBmdW5jdGlvbiBjb3ZlcmFnZXMuXG4gKlxuICogRnVuY3Rpb25zIGFyZSBtYXRjaGluZyBpZiB0aGVpciByb290IHJhbmdlcyBoYXZlIHRoZSBzYW1lIHNwYW4uXG4gKiBUaGUgcmVzdWx0IGlzIG5vcm1hbGl6ZWQuXG4gKiBUaGUgaW5wdXQgdmFsdWVzIG1heSBiZSBtdXRhdGVkLCBpdCBpcyBub3Qgc2FmZSB0byB1c2UgdGhlbSBhZnRlciBwYXNzaW5nXG4gKiB0aGVtIHRvIHRoaXMgZnVuY3Rpb24uXG4gKiBUaGUgY29tcHV0YXRpb24gaXMgc3luY2hyb25vdXMuXG4gKlxuICogQHBhcmFtIGZ1bmNDb3ZzIEZ1bmN0aW9uIGNvdmVyYWdlcyB0byBtZXJnZS5cbiAqIEByZXR1cm4gTWVyZ2VkIGZ1bmN0aW9uIGNvdmVyYWdlLCBvciBgdW5kZWZpbmVkYCBpZiB0aGUgaW5wdXQgbGlzdCB3YXMgZW1wdHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUZ1bmN0aW9uQ292cyhmdW5jQ292czogUmVhZG9ubHlBcnJheTxGdW5jdGlvbkNvdj4pOiBGdW5jdGlvbkNvdiB8IHVuZGVmaW5lZCB7XG4gIGlmIChmdW5jQ292cy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9IGVsc2UgaWYgKGZ1bmNDb3ZzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IG1lcmdlZDogRnVuY3Rpb25Db3YgPSBmdW5jQ292c1swXTtcbiAgICBub3JtYWxpemVGdW5jdGlvbkNvdihtZXJnZWQpO1xuICAgIHJldHVybiBtZXJnZWQ7XG4gIH1cblxuICBjb25zdCBmdW5jdGlvbk5hbWU6IHN0cmluZyA9IGZ1bmNDb3ZzWzBdLmZ1bmN0aW9uTmFtZTtcblxuICBjb25zdCB0cmVlczogUmFuZ2VUcmVlW10gPSBbXTtcbiAgZm9yIChjb25zdCBmdW5jQ292IG9mIGZ1bmNDb3ZzKSB7XG4gICAgLy8gYXNzZXJ0OiBgZm4ucmFuZ2VzLmxlbmd0aCA+IDBgXG4gICAgLy8gYXNzZXJ0OiBgZm4ucmFuZ2VzYCBpcyBzb3J0ZWRcbiAgICB0cmVlcy5wdXNoKFJhbmdlVHJlZS5mcm9tU29ydGVkUmFuZ2VzKGZ1bmNDb3YucmFuZ2VzKSEpO1xuICB9XG5cbiAgLy8gYXNzZXJ0OiBgdHJlZXMubGVuZ3RoID4gMGBcbiAgY29uc3QgbWVyZ2VkVHJlZTogUmFuZ2VUcmVlID0gbWVyZ2VSYW5nZVRyZWVzKHRyZWVzKSE7XG4gIG5vcm1hbGl6ZVJhbmdlVHJlZShtZXJnZWRUcmVlKTtcbiAgY29uc3QgcmFuZ2VzOiBSYW5nZUNvdltdID0gbWVyZ2VkVHJlZS50b1JhbmdlcygpO1xuICBjb25zdCBpc0Jsb2NrQ292ZXJhZ2U6IGJvb2xlYW4gPSAhKHJhbmdlcy5sZW5ndGggPT09IDEgJiYgcmFuZ2VzWzBdLmNvdW50ID09PSAwKTtcblxuICBjb25zdCBtZXJnZWQ6IEZ1bmN0aW9uQ292ID0ge2Z1bmN0aW9uTmFtZSwgcmFuZ2VzLCBpc0Jsb2NrQ292ZXJhZ2V9O1xuICAvLyBhc3NlcnQ6IGBtZXJnZWRgIGlzIG5vcm1hbGl6ZWRcbiAgcmV0dXJuIG1lcmdlZDtcbn1cblxuLyoqXG4gKiBAcHJlY29uZGl0aW9uIFNhbWUgYHN0YXJ0YCBhbmQgYGVuZGAgZm9yIGFsbCB0aGUgdHJlZXNcbiAqL1xuZnVuY3Rpb24gbWVyZ2VSYW5nZVRyZWVzKHRyZWVzOiBSZWFkb25seUFycmF5PFJhbmdlVHJlZT4pOiBSYW5nZVRyZWUgfCB1bmRlZmluZWQge1xuICBpZiAodHJlZXMubGVuZ3RoIDw9IDEpIHtcbiAgICByZXR1cm4gdHJlZXNbMF07XG4gIH1cbiAgY29uc3QgZmlyc3Q6IFJhbmdlVHJlZSA9IHRyZWVzWzBdO1xuICBsZXQgZGVsdGE6IG51bWJlciA9IDA7XG4gIGZvciAoY29uc3QgdHJlZSBvZiB0cmVlcykge1xuICAgIGRlbHRhICs9IHRyZWUuZGVsdGE7XG4gIH1cbiAgY29uc3QgY2hpbGRyZW46IFJhbmdlVHJlZVtdID0gbWVyZ2VSYW5nZVRyZWVDaGlsZHJlbih0cmVlcyk7XG4gIHJldHVybiBuZXcgUmFuZ2VUcmVlKGZpcnN0LnN0YXJ0LCBmaXJzdC5lbmQsIGRlbHRhLCBjaGlsZHJlbik7XG59XG5cbmNsYXNzIFJhbmdlVHJlZVdpdGhQYXJlbnQge1xuICByZWFkb25seSBwYXJlbnRJbmRleDogbnVtYmVyO1xuICByZWFkb25seSB0cmVlOiBSYW5nZVRyZWU7XG5cbiAgY29uc3RydWN0b3IocGFyZW50SW5kZXg6IG51bWJlciwgdHJlZTogUmFuZ2VUcmVlKSB7XG4gICAgdGhpcy5wYXJlbnRJbmRleCA9IHBhcmVudEluZGV4O1xuICAgIHRoaXMudHJlZSA9IHRyZWU7XG4gIH1cbn1cblxuY2xhc3MgU3RhcnRFdmVudCB7XG4gIHJlYWRvbmx5IG9mZnNldDogbnVtYmVyO1xuICByZWFkb25seSB0cmVlczogUmFuZ2VUcmVlV2l0aFBhcmVudFtdO1xuXG4gIGNvbnN0cnVjdG9yKG9mZnNldDogbnVtYmVyLCB0cmVlczogUmFuZ2VUcmVlV2l0aFBhcmVudFtdKSB7XG4gICAgdGhpcy5vZmZzZXQgPSBvZmZzZXQ7XG4gICAgdGhpcy50cmVlcyA9IHRyZWVzO1xuICB9XG5cbiAgc3RhdGljIGNvbXBhcmUoYTogU3RhcnRFdmVudCwgYjogU3RhcnRFdmVudCk6IG51bWJlciB7XG4gICAgcmV0dXJuIGEub2Zmc2V0IC0gYi5vZmZzZXQ7XG4gIH1cbn1cblxuY2xhc3MgU3RhcnRFdmVudFF1ZXVlIHtcbiAgcHJpdmF0ZSByZWFkb25seSBxdWV1ZTogU3RhcnRFdmVudFtdO1xuICBwcml2YXRlIG5leHRJbmRleDogbnVtYmVyO1xuICBwcml2YXRlIHBlbmRpbmdPZmZzZXQ6IG51bWJlcjtcbiAgcHJpdmF0ZSBwZW5kaW5nVHJlZXM6IFJhbmdlVHJlZVdpdGhQYXJlbnRbXSB8IHVuZGVmaW5lZDtcblxuICBwcml2YXRlIGNvbnN0cnVjdG9yKHF1ZXVlOiBTdGFydEV2ZW50W10pIHtcbiAgICB0aGlzLnF1ZXVlID0gcXVldWU7XG4gICAgdGhpcy5uZXh0SW5kZXggPSAwO1xuICAgIHRoaXMucGVuZGluZ09mZnNldCA9IDA7XG4gICAgdGhpcy5wZW5kaW5nVHJlZXMgPSB1bmRlZmluZWQ7XG4gIH1cblxuICBzdGF0aWMgZnJvbVBhcmVudFRyZWVzKHBhcmVudFRyZWVzOiBSZWFkb25seUFycmF5PFJhbmdlVHJlZT4pOiBTdGFydEV2ZW50UXVldWUge1xuICAgIGNvbnN0IHN0YXJ0VG9UcmVlczogTWFwPG51bWJlciwgUmFuZ2VUcmVlV2l0aFBhcmVudFtdPiA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IFtwYXJlbnRJbmRleCwgcGFyZW50VHJlZV0gb2YgcGFyZW50VHJlZXMuZW50cmllcygpKSB7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHBhcmVudFRyZWUuY2hpbGRyZW4pIHtcbiAgICAgICAgbGV0IHRyZWVzOiBSYW5nZVRyZWVXaXRoUGFyZW50W10gfCB1bmRlZmluZWQgPSBzdGFydFRvVHJlZXMuZ2V0KGNoaWxkLnN0YXJ0KTtcbiAgICAgICAgaWYgKHRyZWVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICB0cmVlcyA9IFtdO1xuICAgICAgICAgIHN0YXJ0VG9UcmVlcy5zZXQoY2hpbGQuc3RhcnQsIHRyZWVzKTtcbiAgICAgICAgfVxuICAgICAgICB0cmVlcy5wdXNoKG5ldyBSYW5nZVRyZWVXaXRoUGFyZW50KHBhcmVudEluZGV4LCBjaGlsZCkpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBxdWV1ZTogU3RhcnRFdmVudFtdID0gW107XG4gICAgZm9yIChjb25zdCBbc3RhcnRPZmZzZXQsIHRyZWVzXSBvZiBzdGFydFRvVHJlZXMpIHtcbiAgICAgIHF1ZXVlLnB1c2gobmV3IFN0YXJ0RXZlbnQoc3RhcnRPZmZzZXQsIHRyZWVzKSk7XG4gICAgfVxuICAgIHF1ZXVlLnNvcnQoU3RhcnRFdmVudC5jb21wYXJlKTtcbiAgICByZXR1cm4gbmV3IFN0YXJ0RXZlbnRRdWV1ZShxdWV1ZSk7XG4gIH1cblxuICBzZXRQZW5kaW5nT2Zmc2V0KG9mZnNldDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5wZW5kaW5nT2Zmc2V0ID0gb2Zmc2V0O1xuICB9XG5cbiAgcHVzaFBlbmRpbmdUcmVlKHRyZWU6IFJhbmdlVHJlZVdpdGhQYXJlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5wZW5kaW5nVHJlZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhpcy5wZW5kaW5nVHJlZXMgPSBbXTtcbiAgICB9XG4gICAgdGhpcy5wZW5kaW5nVHJlZXMucHVzaCh0cmVlKTtcbiAgfVxuXG4gIG5leHQoKTogU3RhcnRFdmVudCB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgcGVuZGluZ1RyZWVzOiBSYW5nZVRyZWVXaXRoUGFyZW50W10gfCB1bmRlZmluZWQgPSB0aGlzLnBlbmRpbmdUcmVlcztcbiAgICBjb25zdCBuZXh0RXZlbnQ6IFN0YXJ0RXZlbnQgfCB1bmRlZmluZWQgPSB0aGlzLnF1ZXVlW3RoaXMubmV4dEluZGV4XTtcbiAgICBpZiAocGVuZGluZ1RyZWVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMubmV4dEluZGV4Kys7XG4gICAgICByZXR1cm4gbmV4dEV2ZW50O1xuICAgIH0gZWxzZSBpZiAobmV4dEV2ZW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMucGVuZGluZ1RyZWVzID0gdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIG5ldyBTdGFydEV2ZW50KHRoaXMucGVuZGluZ09mZnNldCwgcGVuZGluZ1RyZWVzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKHRoaXMucGVuZGluZ09mZnNldCA8IG5leHRFdmVudC5vZmZzZXQpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nVHJlZXMgPSB1bmRlZmluZWQ7XG4gICAgICAgIHJldHVybiBuZXcgU3RhcnRFdmVudCh0aGlzLnBlbmRpbmdPZmZzZXQsIHBlbmRpbmdUcmVlcyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAodGhpcy5wZW5kaW5nT2Zmc2V0ID09PSBuZXh0RXZlbnQub2Zmc2V0KSB7XG4gICAgICAgICAgdGhpcy5wZW5kaW5nVHJlZXMgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgZm9yIChjb25zdCB0cmVlIG9mIHBlbmRpbmdUcmVlcykge1xuICAgICAgICAgICAgbmV4dEV2ZW50LnRyZWVzLnB1c2godHJlZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRoaXMubmV4dEluZGV4Kys7XG4gICAgICAgIHJldHVybiBuZXh0RXZlbnQ7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1lcmdlUmFuZ2VUcmVlQ2hpbGRyZW4ocGFyZW50VHJlZXM6IFJlYWRvbmx5QXJyYXk8UmFuZ2VUcmVlPik6IFJhbmdlVHJlZVtdIHtcbiAgY29uc3QgcmVzdWx0OiBSYW5nZVRyZWVbXSA9IFtdO1xuICBjb25zdCBzdGFydEV2ZW50UXVldWU6IFN0YXJ0RXZlbnRRdWV1ZSA9IFN0YXJ0RXZlbnRRdWV1ZS5mcm9tUGFyZW50VHJlZXMocGFyZW50VHJlZXMpO1xuICBjb25zdCBwYXJlbnRUb05lc3RlZDogTWFwPG51bWJlciwgUmFuZ2VUcmVlW10+ID0gbmV3IE1hcCgpO1xuICBsZXQgb3BlblJhbmdlOiBSYW5nZSB8IHVuZGVmaW5lZDtcblxuICB3aGlsZSAodHJ1ZSkge1xuICAgIGNvbnN0IGV2ZW50OiBTdGFydEV2ZW50IHwgdW5kZWZpbmVkID0gc3RhcnRFdmVudFF1ZXVlLm5leHQoKTtcbiAgICBpZiAoZXZlbnQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgaWYgKG9wZW5SYW5nZSAhPT0gdW5kZWZpbmVkICYmIG9wZW5SYW5nZS5lbmQgPD0gZXZlbnQub2Zmc2V0KSB7XG4gICAgICByZXN1bHQucHVzaChuZXh0Q2hpbGQob3BlblJhbmdlLCBwYXJlbnRUb05lc3RlZCkpO1xuICAgICAgb3BlblJhbmdlID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmIChvcGVuUmFuZ2UgPT09IHVuZGVmaW5lZCkge1xuICAgICAgbGV0IG9wZW5SYW5nZUVuZDogbnVtYmVyID0gZXZlbnQub2Zmc2V0ICsgMTtcbiAgICAgIGZvciAoY29uc3Qge3BhcmVudEluZGV4LCB0cmVlfSBvZiBldmVudC50cmVlcykge1xuICAgICAgICBvcGVuUmFuZ2VFbmQgPSBNYXRoLm1heChvcGVuUmFuZ2VFbmQsIHRyZWUuZW5kKTtcbiAgICAgICAgaW5zZXJ0Q2hpbGQocGFyZW50VG9OZXN0ZWQsIHBhcmVudEluZGV4LCB0cmVlKTtcbiAgICAgIH1cbiAgICAgIHN0YXJ0RXZlbnRRdWV1ZS5zZXRQZW5kaW5nT2Zmc2V0KG9wZW5SYW5nZUVuZCk7XG4gICAgICBvcGVuUmFuZ2UgPSB7c3RhcnQ6IGV2ZW50Lm9mZnNldCwgZW5kOiBvcGVuUmFuZ2VFbmR9O1xuICAgIH0gZWxzZSB7XG4gICAgICBmb3IgKGNvbnN0IHtwYXJlbnRJbmRleCwgdHJlZX0gb2YgZXZlbnQudHJlZXMpIHtcbiAgICAgICAgaWYgKHRyZWUuZW5kID4gb3BlblJhbmdlLmVuZCkge1xuICAgICAgICAgIGNvbnN0IHJpZ2h0OiBSYW5nZVRyZWUgPSB0cmVlLnNwbGl0KG9wZW5SYW5nZS5lbmQpO1xuICAgICAgICAgIHN0YXJ0RXZlbnRRdWV1ZS5wdXNoUGVuZGluZ1RyZWUobmV3IFJhbmdlVHJlZVdpdGhQYXJlbnQocGFyZW50SW5kZXgsIHJpZ2h0KSk7XG4gICAgICAgIH1cbiAgICAgICAgaW5zZXJ0Q2hpbGQocGFyZW50VG9OZXN0ZWQsIHBhcmVudEluZGV4LCB0cmVlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKG9wZW5SYW5nZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVzdWx0LnB1c2gobmV4dENoaWxkKG9wZW5SYW5nZSwgcGFyZW50VG9OZXN0ZWQpKTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIGluc2VydENoaWxkKHBhcmVudFRvTmVzdGVkOiBNYXA8bnVtYmVyLCBSYW5nZVRyZWVbXT4sIHBhcmVudEluZGV4OiBudW1iZXIsIHRyZWU6IFJhbmdlVHJlZSk6IHZvaWQge1xuICBsZXQgbmVzdGVkOiBSYW5nZVRyZWVbXSB8IHVuZGVmaW5lZCA9IHBhcmVudFRvTmVzdGVkLmdldChwYXJlbnRJbmRleCk7XG4gIGlmIChuZXN0ZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIG5lc3RlZCA9IFtdO1xuICAgIHBhcmVudFRvTmVzdGVkLnNldChwYXJlbnRJbmRleCwgbmVzdGVkKTtcbiAgfVxuICBuZXN0ZWQucHVzaCh0cmVlKTtcbn1cblxuZnVuY3Rpb24gbmV4dENoaWxkKG9wZW5SYW5nZTogUmFuZ2UsIHBhcmVudFRvTmVzdGVkOiBNYXA8bnVtYmVyLCBSYW5nZVRyZWVbXT4pOiBSYW5nZVRyZWUge1xuICBjb25zdCBtYXRjaGluZ1RyZWVzOiBSYW5nZVRyZWVbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgbmVzdGVkIG9mIHBhcmVudFRvTmVzdGVkLnZhbHVlcygpKSB7XG4gICAgaWYgKG5lc3RlZC5sZW5ndGggPT09IDEgJiYgbmVzdGVkWzBdLnN0YXJ0ID09PSBvcGVuUmFuZ2Uuc3RhcnQgJiYgbmVzdGVkWzBdLmVuZCA9PT0gb3BlblJhbmdlLmVuZCkge1xuICAgICAgbWF0Y2hpbmdUcmVlcy5wdXNoKG5lc3RlZFswXSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1hdGNoaW5nVHJlZXMucHVzaChuZXcgUmFuZ2VUcmVlKFxuICAgICAgICBvcGVuUmFuZ2Uuc3RhcnQsXG4gICAgICAgIG9wZW5SYW5nZS5lbmQsXG4gICAgICAgIDAsXG4gICAgICAgIG5lc3RlZCxcbiAgICAgICkpO1xuICAgIH1cbiAgfVxuICBwYXJlbnRUb05lc3RlZC5jbGVhcigpO1xuICByZXR1cm4gbWVyZ2VSYW5nZVRyZWVzKG1hdGNoaW5nVHJlZXMpITtcbn1cbiJdLCJzb3VyY2VSb290IjoiIn0=
