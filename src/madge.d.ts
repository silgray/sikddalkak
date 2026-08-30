// `@types/madge` 는 5.x용이라 우리가 쓰는 8.x API와 맞지 않을 수 있다(버전 격차 미확인).
// 실제로 쓰는 곳(`importGraph.test.ts`)이 필요한 부분만 그 파일 안에서 좁게 재선언하므로,
// 여기서는 모듈 존재만 알려 `noImplicitAny` 를 통과시킨다.
declare module 'madge';
