'use client';

import { useEffect, useRef } from 'react';
import type { EChartsType } from 'echarts';

export type ChartClick = { name?: string; value?: unknown; dataIndex?: number };

/** Thin ECharts host: lazy-loads the library, resizes with its box, reports clicks. */
export function EChart({ option, label, onSelect, onReady }: {
  option: Record<string, unknown>; label: string;
  onSelect?: (event: ChartClick) => void; onReady?: (instance: EChartsType | null) => void;
}) {
  const node = useRef<HTMLElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const select = useRef(onSelect);
  const ready = useRef(onReady);
  useEffect(() => { select.current = onSelect; ready.current = onReady; });

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import('echarts').then(echarts => {
      if (disposed || !node.current) return;
      const instance = echarts.init(node.current, undefined, { renderer: 'canvas' });
      chart.current = instance;
      instance.on('click', params => select.current?.(params as ChartClick));
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(node.current);
      ready.current?.(instance);
    });
    return () => { disposed = true; observer?.disconnect(); ready.current?.(null); chart.current?.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      if (chart.current) chart.current.setOption(option, { notMerge: true });
      else setTimeout(apply, 30);
    };
    apply();
    return () => { cancelled = true; };
  }, [option]);

  return <figure ref={node} className="dash-chart-canvas" aria-label={label} />;
}
