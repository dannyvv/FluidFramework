import {
    Segment,
    Marker,
    TextSegment,
    ReferenceType,
} from "@prague/merge-tree";
import { Template, Dom } from "@prague/flow-util";
import { getInclusionKind, getInclusionHtml, getInclusionComponent, FlowDocument, DocSegmentKind, getDocSegmentKind, InclusionKind } from "@chaincode/flow-document";
import { ParagraphView, IParagraphProps, IParagraphViewState } from "../paragraph";
import { LineBreakView } from "../linebreak";
import { TextView } from "../text";
import { View, IViewState } from "../";
import { InclusionView } from "../inclusion";
import { TextAccumulator } from "./textaccumulator";
import * as styles from "./index.css";

const template = new Template({
    tag: "span",
    props: { className: styles.document, },
    children: [
        { tag: "span", ref: "leadingSpan", props: { className: styles.leadingSpan }},
        { tag: "span", ref: "slot", props: { className: styles.documentContent, tabIndex: 0 }},
        { tag: "span", ref: "trailingSpan", props: { className: styles.trailingSpan }},
        { tag: "span", ref: "overlay", props: { className: styles.documentOverlay }}
    ]
});

/**
 * A position in the FlowDocument and a callback to be invoked with the DOM node
 * and offset within the dom node where that position is rendered.
 */
export interface ITrackedPosition {
    position: number, 
    callback: (node: Node, nodeOffset: number) => void
};

/**
 * The state to be visualized/edited by the DocumentView.
 */
export interface IDocumentProps {
    doc: FlowDocument;
    trackedPositions: ITrackedPosition[];
    start: number;
}

/**
 * The state that is calculated/cached for each segment within the currently rendered
 * window.
 */
export interface IViewInfo<TProps, TState extends IViewState, TView extends View<TProps, TState>> {
    /** 
     * The document-ordered list of segments visualized by the cached 'view' instance.
     * (Currently, only TextSegments are combined into a single view/element.  Other segment
     * types are 1:1.)
     */
    segments: Segment[];

    /** The IView instance that rendered this set of segments. */
    view: TView;

    /** Cached ClientRects that bound this view. */
    clientRects?: ClientRectList | DOMRectList;
}

/**
 * The state maintained by the DocumentView instance.
 */
interface IDocumentViewState extends IViewState {
    /** The root element into which segments are rendered. */
    slot: HTMLElement,

    /** The root element into which overlays are attached. */
    overlay: Element,

    /** Leading span */
    leadingSpan: Element,
    trailingSpan: Element,
    leadingParagraph: Marker,
    trailingParagraph: Marker,

    /** 
     * Mapping from segments to their IViewInfo, if the segment is currently within the rendered window.
     * Note that when a range of segments are rendered by a single view (as is the case with TextSegments
     * that share the same style), only the first segment in the range appears in this map.
     */
    segmentToViewInfo: Map<Segment, IViewInfo<any, IViewState, View<any, IViewState>>>;

    /**
     * Mapping from the root element produced by an IView to it's IViewInfo.
     */
    elementToViewInfo: Map<Element, IViewInfo<any, IViewState, View<any, IViewState>>>;
}

/** IView that renders a FlowDocument. */
export class DocumentView {
    private state?: IDocumentViewState;

    public mount(props: IDocumentProps) {
        const root = template.clone();
        const leadingSpan = template.get(root, "leadingSpan");
        const slot = template.get(root, "slot") as HTMLElement;
        const overlay = template.get(root, "overlay");
        const trailingSpan = template.get(root, "trailingSpan");

        const leadingParagraph = FlowDocument.markAsParagraph(new Marker(ReferenceType.Tile));
        const trailingParagraph = FlowDocument.markAsParagraph(new Marker(ReferenceType.Tile));

        this.state = {
            root,
            slot,
            leadingSpan,
            trailingSpan,
            overlay,
            leadingParagraph,
            trailingParagraph,
            segmentToViewInfo: new Map<Segment, IViewInfo<any, IViewState, View<any, IViewState>>>(),
            elementToViewInfo: new Map<Element, IViewInfo<any, IViewState, View<any, IViewState>>>()
        };

        return this.update(props);
    }

    public get root()       { return this.state!.root; }
    public get slot()       { return this.state!.slot; }
    public get overlay()    { return this.state!.overlay; }

    public update(props: Readonly<IDocumentProps>) {
        DocumentLayout.sync(props, this.state!);
    }

    public unmount() { }

    /** Map a node/nodeOffset to the corresponding segment/segmentOffset that rendered it. */
    private nodeOffsetToSegmentOffset(node: Node | null, nodeOffset: number) {
        const state = this.state!;
        let viewInfo: IViewInfo<any, IViewState, View<any, IViewState>> | undefined;
        while (node && !(viewInfo = state.elementToViewInfo.get(node as Element))) {
            node = node.parentElement;
        }

        if (!viewInfo) {
            return undefined;
        }

        let segment: Segment | undefined = undefined;
        for (segment of viewInfo.segments) {
            if (nodeOffset < segment.cachedLength) {
                return { segment, offset: nodeOffset };
            }
            nodeOffset -= segment.cachedLength;
        }

        return segment && { segment, offset: segment.cachedLength };
    }

    /** Returns the { segment, offset } currently visible at the given x/y coordinates (if any). */
    public hitTest(x: number, y: number) {
        const range = document.caretRangeFromPoint(x, y);
        const segmentAndOffset = this.nodeOffsetToSegmentOffset(range.startContainer, range.startOffset);
        console.log(`  (${x},${y}) -> "${range.startContainer.textContent}":${range.startOffset} -> ${
            segmentAndOffset
                ? `${(segmentAndOffset.segment as TextSegment).text}:${segmentAndOffset.offset}`
                : `undefined`}`);
        return segmentAndOffset;
    }
 
    /** Returns the closest { segment, offset } to the 0-width rect described by x/top/bottom. */
    private findDomPosition(node: Node, x: number, yMin: number, yMax: number) {
        // Note: Caller must pass a 'node' that was previously rendered for a TextSegment.
        const domRange = document.createRange();
        let left = 0
        let right = node.textContent!.length;

        while (left < right) {
            const m = (left + right) >>> 1;
            domRange.setStart(node, m);
            domRange.setEnd(node, m);

            // Note: On Safari 12, 'domRange.getBoundingClientRect()' returns an empty rectangle when domRange start === end.
            //       However, 'getClientRects()' for the same range returns the expected 0-width rect.
            const bounds = domRange.getClientRects()[0];
            const cy = (bounds.top + bounds.bottom) / 2;
            if ((cy < yMin)                                     // Current position is above our target rect.
                || (cy < yMax && bounds.left < x)) {            // Current position is within our desired y range.
                left = m + 1;
            } else {
                right = m;
            }
        }

        return this.nodeOffsetToSegmentOffset(node, left);
    }

    /** Get the ClientRects that define the boundary of the given 'element', using cached information if we have it. */
    private getClientRects(element: Element) {
        // Note: Caller must only request clientRects for elements we've previously rendered.
        const state = this.state!;
        const viewInfo = state.elementToViewInfo.get(element)!;
        if (!viewInfo.clientRects) {
            viewInfo.clientRects = element.getClientRects();
        }
        return viewInfo.clientRects;
    }

    private getCursorTarget<TProps, TState extends IViewState, TView extends View<TProps, TState>>(viewInfo: IViewInfo<TProps, TState, TView>) {
        const state = viewInfo.view.state;
        const maybeCursorTarget = (state as any)["cursorTarget"];

        // Note: 'root.firstChild' expected to be non-null 
        return maybeCursorTarget || state.root.firstChild!;
    }

    /**
     * Returns the closest { segment, offset } below the text cursor occupying the 0-width rect
     * described by x/top/bottom.
     */
    public findBelow(x: number, top: number, bottom: number) {
        console.log(`looking below: ${bottom}`);

        const state = this.state!;
        let bestRect = { top: +Infinity, bottom: -Infinity, left: +Infinity, right: -Infinity };
        let bestDx = +Infinity;
        let bestViewInfo: IViewInfo<any, IViewState, View<any, IViewState>> | undefined = undefined;

        for (const viewInfo of state.elementToViewInfo.values()) {
            // Only consider text segments.
            if (viewInfo.view instanceof TextView) {
                continue;
            }

            const state = viewInfo.view.state;
            const node = state.root;
            const rects = this.getClientRects(node);
            console.log(`rects: ${rects.length} for ${node.textContent}`);
            
            for (const rect of rects) {
                console.log(`    ${JSON.stringify(rect)}`);
                // Disqualify any rects at the same height, otherwise our algorithm will select the
                // the current position.
                if (rect.top <= top) {
                    console.log(`        Rejected top: (${rect.top} <= ${top})`)
                    continue;
                }

                // Disqualify any rects lower than our best match.
                if (rect.top > bestRect.top) {
                    console.log(`        Rejected dY: (${rect.top} > ${bestRect.top})`);
                    continue;
                }

                // Accept the new candidate if it is higher than the previous best, or if it's the same
                // height and closer on the x-axis.
                const dx = Math.max(rect.left - x, 0, x - rect.right);
                if (rect.top < bestRect.top || dx < bestDx) {
                    bestRect = rect;
                    bestDx = dx;
                    bestViewInfo = viewInfo;
                    console.log(`    ==> Best candidate: ${bestViewInfo.view.state.root.id}: ${bestViewInfo.view.state.root.textContent}`);
                } else {
                    console.log(`        Rejected d^2: (${dx} > ${bestDx})`);
                }
            }
        }

        // Note: Attempting to hit test using 'caretRangeFromPoint()' against the reported client rect's top/bottom
        //       produced inconsistent results, presumably due to internal fixed-point -> Float32 rounding discrepancies.
        // 
        // Reported edge: 487.99713134765625
        //
        // Boundary case: 487.999999999999971578290569595992 (miss)
        //                487.999999999999971578290569595993 (hit)

        if (!bestViewInfo) {
            console.log(`No best candidate found.`);
            return undefined;
        }
        
        console.log(`Best candidate: ${bestViewInfo.view.state.root.id}: ${bestViewInfo.view.state.root.textContent}`);
        console.log(`    rect: ${JSON.stringify(bestRect)}`);

        return this.findDomPosition(
            this.getCursorTarget(bestViewInfo),
            Math.min(Math.max(x, bestRect.left), bestRect.right),
            bestRect.top, bestRect.bottom);    
    }
}

/** Holds ephemeral state used during layout calculations. */
class LayoutContext {
    /** 
     * Sorted stack of tracked position we're still looking for.  Positions are popped from
     * the stack as the consumers are notified.
     */
    private readonly pendingTrackedPositions: ITrackedPosition[];

    /** 
     * Set of Elements that were previously rendered that have not yet been encountered by
     * this layout pass.  At the end of the layout pass, any remaining elements are unmounted
     * as they are no longer within the rendered window.
     */
    private readonly pendingLayout: Set<Element>;

    /** The IViewInfo for the last rendered inline view. */
    private _currentInline: IViewInfo<any, IViewState, View<any, IViewState>> | null = null;

    /** The IViewInfo for the last rendered paragraph. */
    private _currentParagraph: IViewInfo<IParagraphProps, IParagraphViewState, View<IParagraphProps, IParagraphViewState>> | null = null;

    /** The stack of parent Elements. */
    private readonly parentStack: Element[];

    constructor (readonly props: IDocumentProps, readonly state: IDocumentViewState, root: Element) {
        // Initialize 'pendingTrackedPositions' by copying and sorting the tracked positions.
        this.pendingTrackedPositions = props.trackedPositions
            .slice(0)
            .sort((left, right) => right.position - left.position);
        
        // Initialize 'pendingLayout' with the set of root elements rendered in the last layout pass.
        this.pendingLayout = new Set<Element>(state.elementToViewInfo.keys());

        // Initialize 'parentStack' with the root elment.  We push it twice because the first paragraph
        // will indiscriminately pop it.
        this.parentStack = [root, root];
    }

    // Stack of parent Elements
    public get parent() { return this.parentStack[this.parentStack.length - 1]; }
    public pushParent(newParent: Element) { this.parentStack.push(newParent); }
    public popParent() { return this.parentStack.pop(); }

    /** The next tracked position we're looking for. */
    private get nextTrackedPosition() {
        return this.pendingTrackedPositions[this.pendingTrackedPositions.length - 1];
    }

    /** 
     * Invoked for each DOM node we emit.  Position is the starting position rendered by the current IView.
     */
    public notifyTrackedPositionListeners(node: Node, position: number, segments: { cachedLength: number }[]) {
        const trackedPositions = this.pendingTrackedPositions;
        let topTracked: ITrackedPosition;

        // Notify listeners if we've advanced past a tracked position without intersecting it (e.g., the
        // tracked position is above the rendered window.)  In this case, the calculated position will be
        // negative.
        while ((topTracked = this.nextTrackedPosition) && topTracked.position < position) {
            trackedPositions.pop()!.callback(node, topTracked.position - position);
        }

        // Notify listeners if any of the consumed segments intersected a tracked position.
        let end = position;
        for (const segment of segments) {
            end += segment.cachedLength;
            while ((topTracked = this.nextTrackedPosition) && position <= topTracked.position && topTracked.position < end) {
                // Note: Pop() cannot return 'undefined' per the condition 'topTracked !== undefined' above.
                trackedPositions.pop()!.callback(node, topTracked.position - position);
            }
        }
    }

    /** Invoked at completion of the layout pass to unmount all IViews that are no longer in the rendered window. */
    public unmount() {
        for (const toUnmount of this.pendingLayout) {
            const toUnmountInfo = this.elementToViewInfo(toUnmount)!;
            this.state.elementToViewInfo.delete(toUnmount);
            toUnmount.remove();
            toUnmountInfo.view.unmount();
        }
        
        this.pendingLayout.clear();

        // Rebuild the segment -> ViewInfo map from the remaining visible elements.
        this.state.segmentToViewInfo = new Map<Segment, IViewInfo<any, IViewState, View<any, IViewState>>>(
            [...this.state.elementToViewInfo.values()].map<[Segment, IViewInfo<any, IViewState, View<any, IViewState>>]>(
                viewInfo => [viewInfo.segments[0], viewInfo]));
    }

    public elementToViewInfo(element: Element) { return this.state.elementToViewInfo.get(element); }

    /** 
     * If the given 'segment' is at the head of a list of previously rendered segments, return it's
     * cached ViewInfo and remove that IView from the pendingLayout list.
     */
    public maybeReuseViewInfo<TProps, TState extends IViewState, TView extends View<TProps, TState>>(segment: Segment) {
        const viewInfo = this.state.segmentToViewInfo.get(segment);
        if (viewInfo) {
            this.pendingLayout.delete(viewInfo.view.state.root);
        }
        return viewInfo as IViewInfo<TProps, TState, TView>;
    }

    public pushParagraph(paragraphInfo: IViewInfo<IParagraphProps, IParagraphViewState, View<IParagraphProps, IParagraphViewState>>) {
        this._currentParagraph = paragraphInfo;
        this._currentInline = null;
        this.pushParent(paragraphInfo.view.state.slot);
    }

    public get currentParagraph() { return this._currentParagraph; }

    public setCurrentInline<TProps, TState extends IViewState>(viewInfo: IViewInfo<TProps, TState, View<TProps, TState>>) {
        this._currentInline = viewInfo;
        return viewInfo;
    }

    public get currentInline() { return this._currentInline; }

    public setViewInfo<TProps, TState extends IViewState, TView extends View<TProps, TState>>(viewInfo: IViewInfo<TProps, TState, TView>) {
        this.state.segmentToViewInfo.set(viewInfo.segments[0], viewInfo);
        this.state.elementToViewInfo.set(viewInfo.view.state.root, viewInfo);
        return viewInfo;
    }
}

/** State machine that synchronizes the DOM with the visible portion of the FlowDocument. */
export class DocumentLayout {
    private static mountView<TProps, TState extends IViewState, TView extends View<TProps, TState>>(
        context: LayoutContext,
        segments: Segment[],
        factory: () => TView,
        props: TProps): IViewInfo<TProps, TState, TView>
    {
        const view = factory();
        view.mount(props);

        return context.setViewInfo({
            view,
            segments
        });
    }

    /** 
     * Ensure that the IView for the given set of Segments has been created and that it's root DOM node
     * is at the correct position within the current parent.
     */
    private static syncNode<TProps, TState extends IViewState, TView extends View<TProps, TState>>(
        context: LayoutContext,
        previous: Node | null,
        segments: Segment[],
        factory: () => TView,
        props: TProps): IViewInfo<TProps, TState, TView>
    {
        const parent = context.parent;

        // TODO: Check all non-head segments to look for best match?
        let viewInfo = context.maybeReuseViewInfo<TProps, TState, TView>(segments[0]);
        if (!viewInfo) {
            // Segment was not previously in the rendered window.  Create it.
            viewInfo = this.mountView(context, segments, factory, props);

            // Insert the node for the new segment after the previous block.
            Dom.insertAfter(parent, viewInfo.view.state.root, previous);
        } else {
            viewInfo.segments = segments;
            const view = viewInfo.view;
            view.update(props);

            const node = viewInfo.view.state.root;

            // The node was previously inside the rendered window.  See if it is already in the correct location.
            if (!Dom.isAfterNode(parent, node, previous)) {
                // The node is not in the correct position.  Move it.
                //
                // TODO: Sometimes we have a choice if we move the cached node or the one already residing in the
                //       expected position.  We should prefer to move nodes known not to have side effects (i.e.,
                //       do not move inclusion if possible, and never move the node containing focus.)
                Dom.insertAfter(parent, node, previous);
            }

            // Client bounds have possibly changed.  Clear cached client rects (if any).
            viewInfo.clientRects = undefined;
        }

        return viewInfo;
    }

    /** Ensures that the paragraph's view is mounted and up to date. */
    private static syncParagraph(context: LayoutContext, position: number, marker: Marker) {
        const previousInfo = context.currentParagraph;
        
        context.popParent();

        const viewInfo = context.pushParagraph(
            this.syncNode<IParagraphProps, IParagraphViewState, ParagraphView>(
                context,
                previousInfo && previousInfo.view.state.root,
                [marker],
                ParagraphView.factory,
                {}
            )
        );

        const cursorTarget = previousInfo
            ? previousInfo.view.state.cursorTarget
            : context.state.leadingSpan;
            
        context.notifyTrackedPositionListeners(cursorTarget, position, [marker]);

        return viewInfo;
    }

    /** Ensures that the given inline 'view' is mounted and up to date. */
    private static syncInline<TProps, TState extends IViewState, TView extends View<TProps, TState>>(context: LayoutContext, position: number, segments: Segment[], factory: () => TView, props: TProps) {
        const viewInfo = context.setCurrentInline(
            this.syncNode<TProps, TState, TView>(
                context,
                context.currentInline && context.currentInline.view.state.root!,
                segments,
                factory,
                props));

        const maybeCursorTarget = (viewInfo.view.state as any).cursorTarget;
        context.notifyTrackedPositionListeners(maybeCursorTarget || viewInfo.view.state.root, position, segments);
    }

    /** Ensures that the lineBreak's view is mounted and up to date. */
    private static syncLineBreak(context: LayoutContext, position: number, marker: Marker) {
        this.syncInline(context, position, [ marker ], LineBreakView.factory, {});
    }

    /** Ensures that the text's view is mounted and up to date. */
    private static syncText(context: LayoutContext, position: number, segments: Segment[], text: string) {
       this.syncInline(context, position, segments, TextView.factory, { text });
    }

    private static readonly inclusionRootSym = Symbol("Flow.Editor.Marker.InclusionRoot");

    /** Ensures that a foreign inclusion's view is mounted and up to date. */
    private static syncInclusion(context: LayoutContext, position: number, marker: Marker) {
        let root: HTMLElement;
        const kind = getInclusionKind(marker);

        root = (marker.properties as any)[this.inclusionRootSym];
        if (!root) {
            switch (kind) {
                case InclusionKind.HTML:
                    root = getInclusionHtml(marker);
                    break;
                
                default:
                    console.assert(kind === InclusionKind.Chaincode);
                    root = document.createElement("span");
                    getInclusionComponent(marker, [["div", Promise.resolve(root)]]);
                    break;
            }
            (marker.properties as any)[this.inclusionRootSym] = root;
        }

        this.syncInline(context, position, [ marker ], InclusionView.factory, { root });
    }

    /** 
     * Finds the largest contiguous run of TextSegments that share the same style as 'first', starting at
     * the given 'start' position and returns the concatenated text.
     */
    private static concatTextSegments(context: LayoutContext, position: number, first: TextSegment, relativeStartOffset: number, relativeEndOffset: number)
        : { text: string, style: CSSStyleDeclaration, segments: TextSegment[], nextPosition: number, startPosition: number }
    {
        const accumulator = new TextAccumulator(position, first, relativeStartOffset, relativeEndOffset);
        context.props.doc.visitRange(accumulator.tryConcat, accumulator.nextPosition, position + relativeEndOffset);
        return accumulator;
    }

    private static syncSegment(context: LayoutContext, position: number, segment: Segment, start: number, end: number) {
        const kind = getDocSegmentKind(segment);
        switch (kind) {
            case DocSegmentKind.Text:
                const textInfo = this.concatTextSegments(context, position, segment as TextSegment, start, end);
                this.syncText(context, textInfo.startPosition, textInfo.segments, textInfo.text);

                // Note: We early exit here with the 'end' of the concatenated range of TextSegments.
                //       This will cause the outer loop to skip to the next TextSegment we haven't yet
                //       processed.  (TODO: Consider pushing/popping processors in the outer loop instead?)
                return textInfo.nextPosition;
            
            case DocSegmentKind.Paragraph:
                this.syncParagraph(context, position, segment as Marker);
                break;

            case DocSegmentKind.LineBreak:
                this.syncLineBreak(context, position, segment as Marker);
                break;

            case DocSegmentKind.Inclusion:
                this.syncInclusion(context, position, segment as Marker);
                break;
          
            case DocSegmentKind.EOF:
                this.syncText(context, position, [segment], "\u200B");
                break;
          
            default:
                throw new Error(`Unknown DocSegmentKind '${kind}'.`);
        }

        // By default, continue continue with the next segment.
        return -1;
    }

    /** Runs state machine, starting with the paragraph at 'start'. */
    public static sync(props: IDocumentProps, state: IDocumentViewState) {
        let paragraphStart = props.doc.findParagraphStart(props.start);
        console.log(`Sync starting paragraph @ position ${paragraphStart} (requested start: ${props.start})`);

        const context = new LayoutContext(props, state, state.slot);
        
        if (paragraphStart === undefined) {
            console.log(`    -> synthetic leading paragraph`);
            paragraphStart = props.start;
            this.syncSegment(context, -1, state.leadingParagraph, -1, -1);
        }

        let nextStart = paragraphStart;
        do {
            const start = nextStart;

            // Ensure that we exit the outer do..while loop if there are no remaining segments.
            nextStart = -1;
            context.props.doc.visitRange((position, segment, startOffset, endOffset) => {
                nextStart = this.syncSegment(context, position, segment, startOffset, endOffset);

                // TODO: Halt synchronization once we're off-screen.

                // If the 'syncSegment' returned '-1', proceed to the next segment (if any).
                // Otherwise break to the outer 'do..while' loop and we'll restart at the returned
                // 'next' position.
                return nextStart < 0;
            }, start);
        } while (nextStart >= 0);

        // Notify listeners whose tracked positions were after our rendered window.
        context.notifyTrackedPositionListeners(context.currentParagraph!.view.state.cursorTarget!, +Infinity, []);

        // Any nodes not re-used from the previous layout are unmounted and removed.
        context.unmount();
    }
}