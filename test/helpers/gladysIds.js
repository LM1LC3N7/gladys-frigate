/** The id helpers of the SDK, with the selector Gladys gives the integration. */
export const gladysIds = {
  externalId: (suffix) => `ext:frigate:${suffix}`,
  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return { device, feature: (key) => `${device}:${key}` };
  },
};
