import { type TypedExpr } from "../index";

type Term = {
  term: TypedExpr;
  constant: number;
  sign: number;
  key: string;
}

function sum(params: number[]): number {
  let s = 0;
  params.forEach((x) => {
    s += x;
  });
  return s;
}

function sortVal1(a: TypedExpr): number {
  switch(a.op) {
    case 'num':
      return 0;
    case 'neg':
      return sortVal1(a.operand) + 0.5;
    case 'sym':
      return 1;
      // return a.name
    case 'scalarPow':
      return sortVal1(a.base) * ((a.exponent.op === 'num' && a.exponent.value.kind === 'int')
        ? a.exponent.value.value : sortVal1(a.exponent));
    case 'mul':
      return sortVal1(a.scalar) + sortVal1(a.matrix);
    case 'scalarMul':
      return sum(a.factors.map(sortVal1));
    case 'matMul':
      return sum(a.factors.map(sortVal1));
    default:
      return 0;
  }
}

type opType = "num" | "sym" | "matrix" | "add" | "neg" | "scalarMul" | "matMul" | "mul" | "dot" | "cross" | "transpose" | "matPow" | "scalarPow" | "call" | "frac" | "matIdentity" | "deriv" | "sum" | "prod" | "integral";

const sum_order: opType[] = [
  'prod',
  'sum',
  'integral',
  'deriv',
  'frac',
  'add',
  'cross',
  'dot',
  'num',
  'matIdentity',
];

const sort_key1 = (a: Term, b: Term): number => {
  // return 1;
  const a_val = sortVal1(a.term);
  const b_val = sortVal1(b.term);
  console.log(a.key, a_val);
  console.log(b.key, b_val);
  if(a_val < b_val) return 1;
  if(a_val > b_val) return -1;
  return 0;
};


export const sort_keys = [
    sort_key1,
];