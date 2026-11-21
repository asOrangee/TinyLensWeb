import { useLayoutEffect, useRef, useState } from 'react';

export default function WorkbenchTaskName({ name }: { name: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const normalRef = useRef<HTMLSpanElement>(null);
  const compactRef = useRef<HTMLSpanElement>(null);
  const [compactWidth, setCompactWidth] = useState<number>();

  useLayoutEffect(() => {
    const heading = headingRef.current;
    const normal = normalRef.current;
    const compact = compactRef.current;
    if (!heading || !normal || !compact) return;

    const measure = () => {
      const width = heading.getBoundingClientRect().width;
      const normalWidth = normal.getBoundingClientRect().width;
      const compactWidth = compact.getBoundingClientRect().width;
      // Keep a wrap after reducing the font, even if the smaller text almost fits on one line.
      setCompactWidth(normalWidth > width ? Math.min(width, compactWidth - 1) : undefined);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    observer.observe(normal);
    observer.observe(compact);
    return () => observer.disconnect();
  }, [name]);

  return <h1 ref={headingRef} className="workbench-task-name" title={name} data-compact={compactWidth !== undefined || undefined}>
    <span className="workbench-task-name-copy" style={{ maxInlineSize: compactWidth }}>{name}</span>
    <span ref={normalRef} className="workbench-task-name-measure" aria-hidden="true">{name}</span>
    <span ref={compactRef} className="workbench-task-name-measure workbench-task-name-small" aria-hidden="true">{name}</span>
  </h1>;
}
