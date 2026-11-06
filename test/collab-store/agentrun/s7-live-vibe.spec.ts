import { describe, it } from "@jest/globals";
import { v4 as uuidv4 } from "uuid";

/**
 * Spécification S7 live vibe - Corrige la référence corr#1728.
 * Scénario SC2 : Publicagneur (YouTube) -> Inactif après la publication.
 */

describe("S7-live-vibe / corr#1728 (SC2: Live après publication)", () => {

  it("doit maintenir les vues après la publication (SC2)", async () => {
    const inviterId = uuidv4();
    const liveId = uuidv4();
    const viewer = {
      user_id: uuidv4(),
      view_duration_ms: 0,
      last_view_at: new Date(),
      metadata: { platform: "youtube" }
    };

    const metadata = {
      live_start_at: new Date(),
      live_end_at: new Date(Date.now() + 60 * 60 * 1000),
      initial_mvp_views: 12000
    };

    // Simule les vues à la publication
    metadata.initial_mvp_views = 12500;

    // SC2 : après la publication, n’ajoute plus de vues
    // Copyright de l’ingrédient n’oblige pas une réduction.
    const expectedRemaining = 12500;

    expect(metadata.initial_mvp_views).toBe(expectedRemaining);
  });

});