import { Parser } from "commonmark";
import qs from "qs";
import { createRemoteFileNode } from "gatsby-source-filesystem";
import { getContentTypeSchema } from "./helpers";

/* // console.log("🦄");
// console.log(getContentTypeSchema) */

const reader = new Parser();

/**
 * Retrieves all medias from the markdown
 * @param {String} text
 * @param {String} apiURL
 * @returns {Object[]}
 */
const extractFiles = (text, apiURL) => {
  const StrapiFiles = [];
  // parse the markdown content
  const parsed = reader.parse(text);
  const walker = parsed.walker();
  let event, node;

  while ((event = walker.next())) {
    node = event.node;
    // process image nodes
    if (event.entering && node.type === "image") {
      let destination;
      const alternativeText = node.firstChild?.literal || "";

      if (/^\//.test(node.destination)) {
        destination = `${apiURL}${node.destination}`;
      } else if (/^http/i.test(node.destination)) {
        destination = node.destination;
      }

      if (destination) {
        StrapiFiles.push({ url: destination, src: node.destination, alternativeText });
      }
    }
  }

  return StrapiFiles.filter(Boolean);
};

/**
 * Download file and create node
 * @param {Object} strapiFile
 * @param {Object} ctx
 * @returns {String} node Id
 */
export const downloadStrapiFile = async (strapiFile, context) => {
  const {
    actions: { createNode, touchNode },
    cache,
    createNodeId,
    getNode,
    store,
    strapiConfig,
  } = context;
  const { apiURL, remoteFileHeaders } = strapiConfig;

  let strapiFileNodeID;

  const mediaDataCacheKey = `strapi-media-${strapiFile.id}`;
  const cacheMediaData = await cache.get(mediaDataCacheKey);

  // If we have cached media data and it wasn't modified, reuse
  // previously created file node to not try to redownload
  if (cacheMediaData && cacheMediaData.updatedAt === strapiFile.updatedAt) {
    strapiFileNodeID = cacheMediaData.fileNodeID;
    touchNode(getNode(strapiFileNodeID));
  }

  if (!strapiFileNodeID) {
    try {
      // full media url
      const source_url = `${strapiFile.url.startsWith("http") ? "" : apiURL}${strapiFile.url}`;
      const strapiFileNode = await createRemoteFileNode({
        url: source_url,
        store,
        cache,
        createNode,
        createNodeId,
        httpHeaders: remoteFileHeaders || {},
      });

      // console.log("strapiFileNode", strapiFileNode);

      if (strapiFileNode) {
        strapiFileNodeID = strapiFileNode.id;

        // console.log("strapiFileNodeID", strapiFileNodeID);
        // strapiFileNodeID = strapiFileNode.id + "strapi"; // this breaks things

        await cache.set(mediaDataCacheKey, {
          fileNodeID: strapiFileNodeID,
          updatedAt: strapiFile.updatedAt,
        });
      }
    } catch (error) {
      // Ignore
      console.log("err", error);
    }
  }

  // console.log(strapiFileNodeID);
  return strapiFileNodeID;

};

/**
 * Extract images and create remote nodes for images in all fields.
 * @param {Object} item the entity
 * @param {Object} strapiContext gatsby function
 * @param {String} uid the main schema uid
 */
const extractImages = async (item, strapiContext, uid) => {
  const { schemas, strapiConfig, axiosInstance } = strapiContext;

  // console.log(strapiContext);

  const schema = getContentTypeSchema(schemas, uid);
  const { apiURL } = strapiConfig;

  // console.log(schema);

  for (const strapiAttributeName of Object.keys(item)) {
    const strapiValue = item[strapiAttributeName];

    // console.log("value", value);

    const attribute = schema.schema.attributes[strapiAttributeName];

    // console.log("attribute", attribute);

    const type = attribute?.type || undefined;

    if (strapiValue && type) {
      if (type === "richtext") {
        const extractedStrapiFiles = extractFiles(strapiValue.data, apiURL);

        const strapiFiles = await Promise.all(
          extractedStrapiFiles.map(async ({ url }) => {
            const filters = qs.stringify(
              {
                filters: { url: url.replace(`${apiURL}`, "") },
              },
              { encode: false }
            );

            const { data } = await axiosInstance.get(`/api/upload/strapi-files?${filters}`);
            const strapiFile = data[0];

            if (!strapiFile) {
              return;
            }

            const strapiFileNodeID = await downloadStrapiFile(strapiFile, strapiContext);

            return { strapiFileNodeID: strapiFileNodeID, strapiFile: strapiFile };
          })
        );

        const strapiFileNodes = strapiFiles.filter(Boolean);

        for (const [index, strapiFileNode] of strapiFileNodes.entries()) {
          item[strapiAttributeName].medias.push({
            alternativeText: extractedStrapiFiles[index].alternativeText,
            url: extractedStrapiFiles[index].url,
            src: extractedStrapiFiles[index].src,
            strapiLocalFile___NODE: strapiFileNode.strapiFileNodeID,
            StrapiFile: strapiFileNode.strapiFile,
          });

          // console.log("item", item);
        }
      }

      if (type === "dynamiczone") {
        for (const element of strapiValue) {
          await extractImages(element, strapiContext, element.strapi_component);
        }
      }

      if (type === "component") {
        if (attribute.repeatable) {
          for (const element of strapiValue) {
            await extractImages(element, strapiContext, attribute.component);
          }
        } else {
          await extractImages(strapiValue, strapiContext, attribute.component);
        }
      }

      if (type === "relation") {
        await extractImages(strapiValue, strapiContext, attribute.target);
      }

      if (type === "media") {
        const isMultiple = attribute.multiple;
        const imagesField = isMultiple ? strapiValue : [strapiValue];

        // Dowload all files
        const strapiFiles = await Promise.all(
          imagesField.map(async (strapiFile) => {
            const strapiFileNodeID = await downloadStrapiFile(strapiFile, strapiContext);

            // console.log("strapiFileNodeID", strapiFileNodeID);

            return strapiFileNodeID;
          })
        );

        const strapiImages = strapiFiles.filter(Boolean);

        if (strapiImages && strapiImages.length > 0) {
          if (isMultiple) {
            for (let index = 0; index < strapiValue.length; index++) {
              item[strapiAttributeName][index][`localFile___NODE`] = strapiImages[index];
            }
          } else {
            item[strapiAttributeName][`localFile___NODE`] = isMultiple ? strapiImages : strapiImages[0];
          }
        }
      }
    }
  }
};

// Downloads media from image type fields
export const downloadMediaFiles = async (entities, context, contentTypeUid) =>
  Promise.all(
    entities.map(async (entity) => {
      await extractImages(entity, context, contentTypeUid);
      // console.log("entity", entity);
      // console.log("context", context);
      return entity;
    })
  );
