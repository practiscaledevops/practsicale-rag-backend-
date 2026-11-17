import {it,expect} from 'vitest';
import {withRequestBudget,reserveRequestCost,hasRequestBudget} from '@/lib/request-budget';
it('reserves synchronously across concurrent calls and rejects overspend',async()=>{await withRequestBudget(.1,async()=>{const settle=reserveRequestCost(.08);await Promise.resolve();expect(()=>reserveRequestCost(.03)).toThrow();settle(.04);reserveRequestCost(.05);expect(()=>reserveRequestCost(.02)).toThrow();});expect(hasRequestBudget()).toBe(false);});
it('keeps failed reservations charged and settlement idempotent',()=>withRequestBudget(.1,()=>{const settle=reserveRequestCost(.1);settle(.08);settle(0);expect(()=>reserveRequestCost(.03)).toThrow();}));
it('isolates request limits',async()=>{await Promise.all([withRequestBudget(.01,async()=>{await Promise.resolve();expect(()=>reserveRequestCost(.02)).toThrow();}),withRequestBudget(.1,async()=>{reserveRequestCost(.09);})]);});
it('rejects invalid limits',()=>expect(()=>withRequestBudget(NaN,()=>{})).toThrow());
