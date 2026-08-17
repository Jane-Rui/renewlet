/**
 * 截断文本 Tooltip 组件。
 *
 * 架构位置：用于服务名、URL、通知结果等不可控长度文本，保持表格/卡片不被长词撑开。
 *
 * 注意： 只在实际溢出时展示 tooltip，避免密集列表里制造大量无效浮层。
 */
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipContent>;
type TruncatedTextElement = "span" | "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export type TruncatedTooltipTextProps = {
  text: string;
  as?: TruncatedTextElement;
  className?: string;
  tooltipClassName?: string;
  side?: TooltipContentProps["side"];
  align?: TooltipContentProps["align"];
  disabled?: boolean;
};

function isTextOverflowing(node: HTMLElement) {
  return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
}

type MeasuredTextProps = React.HTMLAttributes<HTMLElement> & {
  as: TruncatedTextElement;
  className: string;
  text: string;
  setNodeRef: React.RefCallback<HTMLElement>;
};

const MeasuredText = React.forwardRef<HTMLElement, MeasuredTextProps>(function MeasuredText(
  { as, className, text, setNodeRef, ...props },
  forwardedRef,
) {
  const handleRef = React.useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef, setNodeRef],
  );

  if (as === "div") {
    return (
      <div {...props} ref={handleRef as React.RefCallback<HTMLDivElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </div>
    );
  }
  if (as === "p") {
    return (
      <p {...props} ref={handleRef as React.RefCallback<HTMLParagraphElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </p>
    );
  }
  if (as === "h1") {
    return (
      <h1 {...props} ref={handleRef as React.RefCallback<HTMLHeadingElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </h1>
    );
  }
  if (as === "h2") {
    return (
      <h2 {...props} ref={handleRef as React.RefCallback<HTMLHeadingElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </h2>
    );
  }
  if (as === "h3") {
    return (
      <h3 {...props} ref={handleRef as React.RefCallback<HTMLHeadingElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </h3>
    );
  }
  if (as === "h4") {
    return (
      <h4 {...props} ref={handleRef as React.RefCallback<HTMLHeadingElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </h4>
    );
  }
  if (as === "h5") {
    return (
      <h5 {...props} ref={handleRef as React.RefCallback<HTMLHeadingElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </h5>
    );
  }
  if (as === "h6") {
    return (
      <h6 {...props} ref={handleRef as React.RefCallback<HTMLHeadingElement>} className={className} data-slot="truncated-tooltip-text">
        {text}
      </h6>
    );
  }
  return (
    <span {...props} ref={handleRef as React.RefCallback<HTMLSpanElement>} className={className} data-slot="truncated-tooltip-text">
      {text}
    </span>
  );
});

export function TruncatedTooltipText({
  text,
  as = "span",
  className,
  tooltipClassName,
  side = "top",
  align = "center",
  disabled = false,
}: TruncatedTooltipTextProps) {
  const nodeRef = React.useRef<HTMLElement | null>(null);
  const [open, setOpen] = React.useState(false);

  const measureOverflow = React.useCallback(() => {
    const node = nodeRef.current;
    if (!node || disabled || !text) {
      return false;
    }

    return isTextOverflowing(node);
  }, [disabled, text]);

  const setNodeRef = React.useCallback(
    (nextNode: HTMLElement | null) => {
      nodeRef.current = nextNode;
    },
    [],
  );

  React.useLayoutEffect(() => {
    if (!measureOverflow()) setOpen(false);

    const node = nodeRef.current;
    if (!node || disabled) return;

    const handleSizeChange = () => {
      if (!measureOverflow()) setOpen(false);
    };
    const ResizeObserverCtor = node.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(handleSizeChange) : null;
    observer?.observe(node);

    window.addEventListener("resize", handleSizeChange);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleSizeChange);
    };
  }, [disabled, measureOverflow]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen && measureOverflow());
    },
    [measureOverflow],
  );

  const element = (
    <MeasuredText
      as={as}
      className={cn("block max-w-full truncate", className)}
      text={text}
      setNodeRef={setNodeRef}
    />
  );

  if (disabled || !text) {
    return element;
  }

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        className={cn("max-w-[calc(100vw-2rem)] whitespace-normal break-words text-xs leading-relaxed sm:max-w-md", tooltipClassName)}
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
