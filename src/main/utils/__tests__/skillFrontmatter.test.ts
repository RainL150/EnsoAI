import { describe, expect, it } from 'vitest';
import { parseSkillFrontMatter } from '../skillFrontmatter';

describe('parseSkillFrontMatter', () => {
  it('parses inline scalars', () => {
    const r = parseSkillFrontMatter(`---\nname: foo\ndescription: bar\n---\n`);
    expect(r).toEqual({ name: 'foo', description: 'bar' });
  });

  it('strips quotes from inline values', () => {
    const r = parseSkillFrontMatter(`---\nname: "foo"\ndescription: 'bar baz'\n---\n`);
    expect(r).toEqual({ name: 'foo', description: 'bar baz' });
  });

  it('parses folded block scalar (>) joining lines with spaces', () => {
    const r = parseSkillFrontMatter(
      `---\nname: x\ndescription: >\n  line one\n  line two\n  line three\n---\n`
    );
    expect(r?.description).toBe('line one line two line three');
  });

  it('treats blank lines inside folded block as paragraph breaks', () => {
    const r = parseSkillFrontMatter(
      `---\nname: x\ndescription: >\n  para one\n  still one\n\n  para two\n---\n`
    );
    expect(r?.description).toBe('para one still one\n\npara two');
  });

  it('parses literal block scalar (|) preserving newlines', () => {
    const r = parseSkillFrontMatter(`---\nname: x\ndescription: |\n  line one\n  line two\n---\n`);
    expect(r?.description).toBe('line one\nline two');
  });

  it('accepts chomp indicators (>-, |+, etc.)', () => {
    const r = parseSkillFrontMatter(`---\nname: x\ndescription: >-\n  trim trailing\n---\n`);
    expect(r?.description).toBe('trim trailing');
  });

  it('handles the real-world stock-earnings-review SKILL.md', () => {
    const content = `---
name: stock-earnings-review
description: >
  依托东方财富数据库，面向沪深京港美五大市场的上市公司/股票，生成业绩点评类输出（含财报分析、业绩解读）。
  当用户明确提出业绩点评、财报分析、业绩解读需求，或出现「业绩点评」「财报点评」「业绩分析」「季报/半年报/年报点评」「财务分析」「盈利分析」「业绩解读」等表述时，应触发本 Skill。
  用户点名具体公司/股票并希望获得业绩与盈利维度的分析评价时，应触发本 Skill。
  即使用户未明说「业绩点评」，只要意图是对该公司财报或业绩作分析解读，也应触发。
---
`;
    const r = parseSkillFrontMatter(content);
    expect(r?.name).toBe('stock-earnings-review');
    expect(r?.description).toContain('依托东方财富数据库');
    expect(r?.description).toContain('即使用户未明说');
    expect(r?.description).not.toBe('>');
    // folded → single line (no paragraph breaks in the source)
    expect(r?.description).not.toContain('\n');
  });

  it('returns null when frontmatter delimiters are missing', () => {
    expect(parseSkillFrontMatter('no frontmatter here')).toBeNull();
    expect(parseSkillFrontMatter('---\nname: x\n')).toBeNull();
  });

  it('returns null when neither name nor description is present', () => {
    expect(parseSkillFrontMatter('---\nversion: 1\n---\n')).toBeNull();
  });
});
