import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";

function createMemoryRouterAt(path: string) {
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

describe("App routing", () => {
  it("renders the index route", async () => {
    const router = createMemoryRouterAt("/");
    await router.load();

    expect(router.state.matches.some((match) => match.routeId === "/")).toBe(true);
  });

  it("renders the not-found route", async () => {
    const router = createMemoryRouterAt("/this-route-does-not-exist");
    await router.load();

    expect(router.state.location.pathname).toBe("/this-route-does-not-exist");
    expect(router.state.matches.some((match) => match.routeId === "__root__")).toBe(true);
  });
});
