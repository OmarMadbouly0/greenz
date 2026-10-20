import { pageArgs } from "../pagination";

it("page 3 with 10 items per page skips 20 items and takes 10", () => {
  const page = 3;
  const pageSize = 10;

  const result = pageArgs(page, pageSize);

  expect(result).toEqual({ skip: 20, take: 10 });
});
