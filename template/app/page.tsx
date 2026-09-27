import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { source } from '../lib/source';
import { getMDXComponents } from '../components/mdx';
import Link from 'next/link';
import site from '../lib/site-config.json';

export default function Home() {
  const index = source.getPage(['index']);
  const Content = index?.data.body;
  return <DocsLayout tree={source.getPageTree()} nav={{ title: site.title }}><DocsPage><DocsTitle>{site.title}</DocsTitle>{index?.data.description && <DocsDescription>{index.data.description}</DocsDescription>}<DocsBody><p>Explore the third party APIs below, or <Link href="/docs">Open the API reference</Link>.</p>{Content && <Content components={getMDXComponents()} />}</DocsBody></DocsPage></DocsLayout>;
}
