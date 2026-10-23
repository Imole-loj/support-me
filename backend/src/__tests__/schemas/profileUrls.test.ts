import { createCreatorSchema, updateCreatorSchema } from "../../schemas/creators";

describe("profile URL validation", () => {
  const savedCloud = process.env.CLOUDINARY_CLOUD_NAME;
  beforeEach(() => { process.env.CLOUDINARY_CLOUD_NAME = "supportme-test"; });
  afterAll(() => {
    if (savedCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = savedCloud;
  });

  it.each([createCreatorSchema, updateCreatorSchema])("accepts an avatar from the configured cloud", (schema) => {
    const avatarUrl = "https://res.cloudinary.com/supportme-test/image/upload/v1/avatar.png";
    expect(schema.parse({ avatarUrl }).avatarUrl).toBe(avatarUrl);
  });

  it.each([
    "javascript:alert(1)", "data:image/png;base64,AAAA", "file:///tmp/avatar.png",
    "http://res.cloudinary.com/supportme-test/image/upload/avatar.png",
    "https://example.com/avatar.png",
    "https://res.cloudinary.com.evil.example/supportme-test/avatar.png",
    "https://res.cloudinary.com/other-cloud/image/upload/avatar.png",
    "https://res.cloudinary.com/supportme-test-extra/avatar.png",
    "https://res.cloudinary.com/supportme-test/../other-cloud/avatar.png",
    "https://res.cloudinary.com@evil.example/supportme-test/avatar.png",
    "https://user:password@res.cloudinary.com/supportme-test/avatar.png",
    "https://res.cloudinary.com:8443/supportme-test/avatar.png",
  ])("rejects unsafe avatar URL %s on creation and update", (avatarUrl) => {
    expect(createCreatorSchema.safeParse({ avatarUrl }).success).toBe(false);
    expect(updateCreatorSchema.safeParse({ avatarUrl }).success).toBe(false);
  });

  it("rejects avatar writes without a configured cloud while allowing other edits", () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    expect(updateCreatorSchema.safeParse({ avatarUrl: "https://res.cloudinary.com/supportme-test/avatar.png" }).success).toBe(false);
    expect(updateCreatorSchema.safeParse({ bio: "Updated bio" }).success).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "mailto:me@example.com", "ftp://example.com", "//example.com", "https://", "https://user:secret@example.com"])(
    "rejects unsafe social link %s", (value) => {
      expect(updateCreatorSchema.safeParse({ socialLinks: { twitter: value } }).success).toBe(false);
      expect(updateCreatorSchema.safeParse({ socialLinks: { website: value } }).success).toBe(false);
    }
  );

  it("preserves full HTTP(S) URLs and expands known platform handles", () => {
    expect(updateCreatorSchema.parse({ socialLinks: {
      twitter: " @alice ", instagram: "alice", youtube: "@channel", tiktok: "@alice",
      github: "alice", linkedin: "in/alice", telegram: "@alice", website: "http://example.com/about",
    } }).socialLinks).toEqual({
      twitter: "https://x.com/alice", instagram: "https://instagram.com/alice",
      youtube: "https://youtube.com/@channel", tiktok: "https://tiktok.com/@alice",
      github: "https://github.com/alice", linkedin: "https://linkedin.com/in/alice",
      telegram: "https://t.me/alice", website: "http://example.com/about",
    });
  });

  it("rejects unknown keys, malformed handles, oversized values and bare website entries", () => {
    for (const socialLinks of [
      { unknown: "https://example.com" }, { twitter: "alice?redirect=evil" },
      { website: "example.com" }, { github: "a".repeat(301) },
    ]) expect(updateCreatorSchema.safeParse({ socialLinks }).success).toBe(false);
    expect(updateCreatorSchema.parse({ socialLinks: {} }).socialLinks).toEqual({});
  });
});
