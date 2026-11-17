import {it,expect} from 'vitest';
import {answerWordLimit,answerWords} from '@/lib/answer-length';
it('honors strict and inclusive ceilings',()=>{expect(answerWordLimit('under 70 words')).toBe(69);expect(answerWordLimit('at most 140 words')).toBe(140);expect(answerWordLimit('a full report')).toBe(null);});
it('counts headings and citations as part of the delivered answer',()=>{expect(answerWords('Subject: Update\n\nHello team [Payroll]')).toBe(5);expect(answerWords(' ')).toBe(0);});
