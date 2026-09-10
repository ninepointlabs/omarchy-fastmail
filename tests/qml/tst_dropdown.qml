import QtQuick
import QtTest
import "../.."

TestCase {
  id: testCase
  name: "PlainTextDropdown"
  when: windowShown

  QtObject {
    id: placementWindow
    property int height: viewport.height
  }

  Item {
    id: viewport
    width: 400
    height: 400

    PlainTextDropdown {
      id: dropdown
      x: 20
      width: 240
      showLabel: false
      options: ["Terminal UI (fm-cli)", "Fastmail App", "Browser"]
      _placementWindow: placementWindow
      _placementContentItem: viewport
    }
  }

  function cleanup() {
    dropdown.close()
    dropdown.y = 0
    dropdown.openUpward = false
    dropdown.options = ["Terminal UI (fm-cli)", "Fastmail App", "Browser"]
    dropdown.value = ""
  }

  function test_object_option_keeps_its_badge_separate_from_its_label() {
    var option = { value: "u12345678", label: "tim@example.com", badge: "3" }
    compare(dropdown.optionLabel(option), "tim@example.com")
    compare(dropdown.optionBadge(option), "3")

    dropdown.options = [option]
    dropdown.value = "u12345678"
    compare(dropdown.currentLabel(), "tim@example.com")
    compare(dropdown.currentOptionBadge(), "3")
  }

  function test_opens_downward_when_the_list_fits_below() {
    dropdown.y = 20
    dropdown.open()

    tryCompare(dropdown, "popupOpen", true)
    compare(dropdown.openUpward, false)
    compare(dropdown._popupY, dropdown.rowHeight + 4)
  }

  function test_opens_upward_when_the_list_would_cross_the_bottom() {
    dropdown.y = viewport.height - dropdown.rowHeight - 8
    dropdown.open()

    tryCompare(dropdown, "popupOpen", true)
    compare(dropdown.openUpward, true)
    compare(dropdown._popupY, -(dropdown._popupHeight + 4))
  }
}
