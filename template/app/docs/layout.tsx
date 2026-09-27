import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '../../lib/source';
import site from '../../lib/site-config.json';

export default function Layout({ children }: { children: ReactNode }) {
  return <DocsLayout tree={source.getPageTree()} nav={{ title: site.title }}>{children}</DocsLayout>;
}
