/**
 * Scaler++ Activity Discovery POC
 *
 * PURPOSE:
 * Prove that we can automatically discover:
 *
 * trimester
 *   -> modules
 *   -> classes
 *   -> assignment/homework test IDs
 *
 * Run this inside the DevTools Console on https://www.scaler.com
 *
 * READ ONLY:
 * This script only performs GET requests.
 */

(async () => {
  "use strict";

  const TRIMESTER = 4;

  const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function scalerFetch(path) {
    console.log("[Scaler++ Discovery] GET", path);

    const response = await fetch(path, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Request failed: ${response.status} ${response.statusText}\n${path}`
      );
    }

    return response.json();
  }

  // --------------------------------------------------
  // 1. TRIMESTER -> MODULES
  // --------------------------------------------------

  async function getModules(trimester) {
    const response = await scalerFetch(
      `/api/v3/super_batches/modules-details?trimester=${trimester}`
    );

    return response?.data ?? [];
  }

  // --------------------------------------------------
  // 2. MODULE -> CLASSES
  // --------------------------------------------------

  async function getClasses(moduleId) {
    const params = new URLSearchParams();

    params.append("filter[academy_module_id]", moduleId);

    params.append("filter[status][]", "active");
    params.append("filter[status][]", "locked");
    params.append("filter[status][]", "repeat");
    params.append("filter[status][]", "bonus");

    params.append("filter[category]", "core");

    params.append("filter[lecture_bucket][]", "Optional");
    params.append("filter[lecture_bucket][]", "Remedial");

    params.append("sort", "date_of_topic");

    params.append(
      "include[]",
      "super_batch_academy_topic.academy_topic"
    );

    params.append(
      "include[]",
      "super_batch_academy_topic"
    );

    params.append(
      "include[]",
      "super_batch_academy_topic.academy_topic.academy_module"
    );

    const response = await scalerFetch(
      `/mentee-academy-topics/classes?${params.toString()}`
    );

    return response?.data ?? [];
  }

  // --------------------------------------------------
  // 3. CLASS -> META
  // --------------------------------------------------

  async function getClassMeta(classId) {
    const response = await scalerFetch(
      `/api/v2/classroom/${classId}/meta`
    );

    return response?.data?.attributes ?? null;
  }

  // --------------------------------------------------
  // Extract class/topic ID
  // --------------------------------------------------

  function getClassId(classItem) {
    return (
      classItem?.relationships
        ?.super_batch_academy_topic
        ?.data
        ?.id ?? null
    );
  }

  // --------------------------------------------------
  // MAIN
  // --------------------------------------------------

  console.log(
    `%cScaler++ Activity Discovery`,
    "font-size:16px;font-weight:bold"
  );

  console.log("Trimester:", TRIMESTER);

  const modules = await getModules(TRIMESTER);

  console.log(`Found ${modules.length} modules`);

  const discovered = [];

  for (const moduleItem of modules) {
    const moduleId =
      moduleItem?.attributes?.id ??
      moduleItem?.id;

    const moduleName =
      moduleItem?.attributes?.name ??
      `Module ${moduleId}`;

    console.log(
      `\n[MODULE] ${moduleName} (${moduleId})`
    );

    if (!moduleId) {
      console.warn("Skipping module without ID", moduleItem);
      continue;
    }

    let classes;

    try {
      classes = await getClasses(moduleId);
    } catch (error) {
      console.error(
        `Could not load classes for ${moduleName}`,
        error
      );

      continue;
    }

    console.log(
      `Found ${classes.length} classes`
    );

    for (const classItem of classes) {
      const classId = getClassId(classItem);

      if (!classId) {
        console.warn(
          "Could not determine class ID",
          classItem
        );

        continue;
      }

      let meta;

      try {
        meta = await getClassMeta(classId);
      } catch (error) {
        console.error(
          `Could not load meta for class ${classId}`,
          error
        );

        continue;
      }

      if (!meta) {
        continue;
      }

      const title =
        meta?.current_topic?.title ??
        `Class ${classId}`;

      const assignment = meta?.assignment ?? null;
      const homework = meta?.homework ?? null;

      const record = {
        trimester: TRIMESTER,

        moduleId,
        moduleName,

        classId,
        title,

        dayNumber:
          meta?.current_topic?.day_number ?? null,

        date:
          meta?.current_topic?.day_of_topic ?? null,

        attendance:
          meta?.attendance ?? null,

        assignment: assignment
          ? {
              testId:
                assignment.test_id ?? null,

              solved:
                assignment.solved ?? 0,

              total:
                assignment.total ?? 0,

              userLessonId:
                assignment.user_lesson_id ?? null,

              startTime:
                assignment.start_time ?? null,
            }
          : null,

        homework: homework
          ? {
              testId:
                homework.test_id ?? null,

              solved:
                homework.solved ?? 0,

              total:
                homework.total ?? 0,

              userLessonId:
                homework.user_lesson_id ?? null,

              startTime:
                homework.start_time ?? null,
            }
          : null,
      };

      discovered.push(record);

      console.log(
        `[CLASS] ${title}`,
        {
          classId,
          assignmentTestId:
            assignment?.test_id ?? null,
          homeworkTestId:
            homework?.test_id ?? null,
        }
      );

      // Avoid firing requests too aggressively.
      await sleep(100);
    }

    await sleep(150);
  }

  // --------------------------------------------------
  // RESULTS
  // --------------------------------------------------

  console.log(
    "\n=============================="
  );

  console.log(
    "DISCOVERY COMPLETE"
  );

  console.log(
    "=============================="
  );

  console.log(
    `Modules: ${modules.length}`
  );

  console.log(
    `Classes discovered: ${discovered.length}`
  );

  const assignmentTests = discovered.filter(
    (item) => item.assignment?.testId
  );

  const homeworkTests = discovered.filter(
    (item) => item.homework?.testId
  );

  console.log(
    `Assignment tests: ${assignmentTests.length}`
  );

  console.log(
    `Homework tests: ${homeworkTests.length}`
  );

  console.table(
    discovered.map((item) => ({
      module: item.moduleName,
      class: item.title,
      classId: item.classId,

      assignment:
        item.assignment?.testId ?? "-",

      assignmentSolved:
        item.assignment
          ? `${item.assignment.solved}/${item.assignment.total}`
          : "-",

      homework:
        item.homework?.testId ?? "-",

      homeworkSolved:
        item.homework
          ? `${item.homework.solved}/${item.homework.total}`
          : "-",
    }))
  );

  // Keep result accessible from DevTools.
  window.__SCALER_ACTIVITY_DISCOVERY__ =
    discovered;

  console.log(
    "\nFull data available at:"
  );

  console.log(
    "window.__SCALER_ACTIVITY_DISCOVERY__"
  );
})();